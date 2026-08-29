import { promises as fs } from "fs";

// Generic file-keyed cache: stores a parsed/derived value for an absolute file
// path and only re-runs the factory when the file's mtime or size has changed.
// This replaces TTL-based caches whose only job was "throw everything out
// occasionally so we eventually pick up edits" — the filesystem already tells
// us when a file changed, so we ask it directly.
//
// Design notes:
// - mtime+size is the change-detection key. Resolution can be 1 s on some FS,
//   but a same-second edit that produces an identical size is vanishingly rare
//   for the append-only JSONL files this is built for.
// - LRU eviction by `lastSeenAt`: with mtime caching, files that never change
//   again sit in memory forever. We sweep on access once we exceed `maxEntries`
//   so a long-running dev server doesn't grow unbounded.
// - Single-flight on the per-file factory: if two callers request the same
//   file simultaneously, only one factory call runs. Cold-path matters for
//   `parseAllSessions()` which this caches — see usage in `parser.ts`.

interface CacheSlot<T> {
  mtimeMs: number;
  size: number;
  value: T;
  lastSeenAt: number;
  /**
   * What this slot charges against `maxBytes`. Usually the file's size, but
   * see the `weigh` option — a file the factory declined to parse retains
   * nothing and must not be charged as though it did.
   */
  weight: number;
}

export interface FileCacheOptions<T = unknown> {
  /**
   * Maximum entries before LRU eviction kicks in. Default: 5000.
   *
   * Size it comfortably ABOVE the file set you expect to sweep. Callers that
   * walk every file on each pass hit LRU's worst case the moment the set
   * exceeds this: the sweep evicts exactly what the next sweep wants first, so
   * the hit rate falls off a cliff to ~0 rather than degrading. See the comment
   * at the `parseAllSessions` cache in `usage/parser.ts` for a measured 22x.
   *
   * This is a runaway backstop, NOT a memory bound — see `maxBytes`.
   */
  maxEntries?: number;
  /**
   * Maximum retained SOURCE bytes before size-based eviction kicks in.
   * Default: unbounded, so existing callers are unaffected until they opt in.
   *
   * **An entry count was never a memory bound (#476).** A slot holds one
   * file's whole parsed value, and transcript sizes span orders of magnitude:
   * measured on the reference corpus, 160 files (2.4%) hold 50% of the bytes,
   * with a p50 of 160 KB against a p99 of 6.7 MB and a 72 MB maximum. So 5,000
   * large files can outweigh 25,000 small ones, and neither number says
   * anything about how much memory is held.
   *
   * Stated in source bytes because that is what `CacheSlot.size` already
   * records and what a caller can reason about. The conversion was measured
   * rather than guessed: parsed `UsageTurn[]` retains **≈2.0× the source
   * bytes** in heap (153 files spanning the size distribution, 57 MB of source
   * → 114 MB of retained heap). Budget accordingly.
   */
  maxBytes?: number;
  /**
   * What a cached value costs against `maxBytes`. Defaults to the file's size.
   *
   * The default is a proxy, and it is wrong in one direction that matters: a
   * factory can decline to parse a file and return an empty value — the usage
   * parser does exactly this above `MAX_SESSION_FILE_SIZE`. Charging that slot
   * the file's full size lets one 72 MB in-progress transcript evict 72 MB of
   * real parsed data while retaining nothing, and, since the just-inserted
   * slot is exempt from eviction, leave the cache nominally over budget with
   * nothing left to drop. (Codex P2, PR #514.)
   */
  weigh?: (value: T, size: number) => number;
}

export class FileCache<T> {
  private readonly slots = new Map<string, CacheSlot<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly weigh: (value: T, size: number) => number;
  /** Running sum of `slot.weight`, so the budget check is O(1) per insert. */
  private retainedBytes = 0;
  /**
   * What the cache has successfully READ, for every such file — independent of
   * whether its parsed value is still resident.
   *
   * **This is the corpus, and `slots` is the residency.** The two were the
   * same thing until `maxBytes` arrived (#476), which is why one map used to
   * answer both questions. Once eviction exists they diverge, and every
   * consumer that wants "what does the corpus look like" — the `(mtime,
   * fileCount)` fingerprint behind `getSessionCategoryCounts` (#492), and the
   * route ETags — wants this one.
   *
   * Three properties it has that a monotone watermark does not, each of which
   * was a real defect found on PR #514:
   *
   *  - **Eviction cannot lower it.** The newest transcript is often also one
   *    of the largest, since an active session grows, so it is exactly what
   *    largest-first eviction takes.
   *  - **A failed parse never enters it.** `stat` succeeding says nothing
   *    about the read; a transient EACCES/EBUSY rejects in the factory. So a
   *    later successful retry genuinely changes this map, even with identical
   *    file metadata.
   *  - **It can FALL.** `retainOnly` prunes it, so deleting the newest
   *    transcript lowers the maximum — which a watermark, being monotone by
   *    construction, could never do.
   *
   * Cheap: two numbers per file, ~6,650 files on the reference corpus. It is
   * the parsed VALUES that are large, and those are what `maxBytes` bounds.
   */
  private readonly meta = new Map<string, { mtimeMs: number; size: number }>();

  /**
   * Files the sweep SAW but deliberately did not read.
   *
   * Separate from `meta` on purpose. `meta` means "successfully read", and that
   * is load-bearing: `getOrCompute` writes it only after a parse resolves, so a
   * file that failed to read stays out of the corpus and a later successful
   * retry MOVES the fingerprint even when mtime and size are unchanged. That is
   * the #498 defect — an EACCES'd transcript whose permissions were restored,
   * touching ctime and nothing else.
   *
   * Registering an unread file in `meta` would have re-opened exactly that hole
   * for a duplicate's alternate: stat-only registration would make a later
   * genuine read look like no change at all (Codex P2, PR #524).
   *
   * A path is in AT MOST ONE of the two — `observe` moves it here, a successful
   * `getOrCompute` moves it back — so the corpus is their union and counting it
   * needs no deduplication.
   */
  private readonly observed = new Map<string, { mtimeMs: number; size: number }>();

  constructor(opts: FileCacheOptions<T> = {}) {
    this.maxEntries = opts.maxEntries ?? 5000;
    this.maxBytes = opts.maxBytes ?? Infinity;
    this.weigh = opts.weigh ?? ((_value, size) => size);
  }

  /** Number of cached entries (for tests and metrics). */
  get size(): number {
    return this.slots.size;
  }

  /** Retained source bytes across all cached entries (for tests and metrics). */
  get bytes(): number {
    return this.retainedBytes;
  }

  /**
   * How many files the cache has successfully read and not since seen removed.
   *
   * The cardinality half of the corpus fingerprint (#492). Distinct from
   * `size`, which counts RESIDENT values — see `meta`.
   */
  get corpusSize(): number {
    // Both halves: files read, and files seen and skipped. A duplicate's
    // alternate is part of the corpus even though nothing parsed it, and a
    // fingerprint that omitted it could not tell "the preferred copy was
    // deleted and the alternate took over" from "nothing changed".
    return this.meta.size + this.observed.size;
  }

  /**
   * Returns the cached value if the file's mtime and size are unchanged,
   * otherwise runs `factory(filePath)`, stores the result, and returns it.
   * Returns `undefined` if the file can't be stat'd (deleted, permission, etc.)
   * — the caller decides whether absence is fatal.
   */
  /**
   * Record a file in the CORPUS without parsing or retaining it.
   *
   * The corpus fingerprint — `corpusSize` and `maxMtimeMs()` — is what route
   * ETags and the category histogram are keyed on, and it is built from `meta`,
   * which only `getOrCompute` used to write. So a file the sweep SAW but chose
   * not to parse was invisible to it.
   *
   * That became reachable with #522's duplicate handling: when one session id
   * has two copies, only the preferred one is parsed. Delete that copy and the
   * alternate takes over — but the fingerprint could be identical either side
   * of the swap, because the count stays at one and a single file's removal
   * rarely moves a maximum taken over thousands. `getSessionCategoryCounts()`
   * then serves its indefinitely-cached histogram for a corpus that changed
   * (Codex P2, PR #524).
   *
   * One `stat`, no read, no slot, no bytes against the budget. Called only for
   * duplicate alternates, which are pathological to begin with.
   */
  async observe(filePath: string): Promise<void> {
    try {
      const stat = await fs.stat(filePath);
      // Into `observed`, and OUT of `meta` — a file that is only being stat'd
      // this cycle is no longer one this cache has read, and leaving a stale
      // "read" record for it is what would mask a later real read.
      this.meta.delete(filePath);
      this.observed.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Gone between enumeration and here. Out of the corpus entirely, for the
      // same reason `getOrCompute` drops it: a deletion has to move the
      // fingerprint.
      this.meta.delete(filePath);
      this.observed.delete(filePath);
    }
  }

  async getOrCompute(
    filePath: string,
    factory: (filePath: string) => Promise<T>
  ): Promise<T | undefined> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // File gone — drop the value AND the corpus entry, so a deletion moves
      // both halves of the fingerprint.
      this.drop(filePath);
      this.meta.delete(filePath);
      this.observed.delete(filePath);
      return undefined;
    }

    const mtimeMs = stat.mtimeMs;
    const size = stat.size;
    const now = Date.now();

    const cached = this.slots.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      cached.lastSeenAt = now;
      return cached.value;
    }

    // Coalesce concurrent requests for the same file. Without this, two callers
    // that both miss the cache would each parse the file independently.
    const existing = this.inFlight.get(filePath);
    if (existing) return existing;

    const promise = (async () => {
      let value: T;
      try {
        value = await factory(filePath);
      } catch (err) {
        // OUT of the corpus, not merely absent from it.
        //
        // Not adding a failed read was enough while `meta` was the only way in:
        // a file that never parsed was never there. `observe` gave it a second
        // door (#522), so an alternate could already be in the corpus when its
        // read failed — and then a later success with mtime and size unchanged
        // (permissions restored, touching only ctime) moved neither half of the
        // `(maxMtime, corpusSize)` fingerprint. `getSessionCategoryCounts()`
        // would serve the histogram cached during the failure indefinitely.
        //
        // Removing it makes the failure itself move the fingerprint, so the
        // recovery moves it back. That is the #498 rule — "a later successful
        // retry genuinely changes this map, even with identical file metadata"
        // — extended to a file that got in without being read (Codex P2,
        // PR #524).
        this.meta.delete(filePath);
        this.observed.delete(filePath);
        throw err;
      }
      // AFTER the factory resolves, never on the way past (Codex P1, PR #514).
      // `stat` succeeding says nothing about the read: a transient EACCES or
      // EBUSY, or a write racing the read, rejects here, and a file that did
      // not parse is not part of the corpus this describes.
      this.meta.set(filePath, { mtimeMs, size });
      // Read now, so it is no longer merely observed. Keeps the two maps
      // disjoint, which is what lets `corpusSize` add them.
      this.observed.delete(filePath);
      // Replace, not add: a changed file already has a slot, and forgetting to
      // subtract the old size is how a running total silently drifts upward
      // until the cache evicts everything.
      this.drop(filePath);
      const weight = Math.max(0, this.weigh(value, size));
      this.slots.set(filePath, {
        mtimeMs,
        size,
        value,
        lastSeenAt: Date.now(),
        weight,
      });
      this.retainedBytes += weight;
      this.evictIfNeeded();
      return value;
    })();

    this.inFlight.set(filePath, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  /** Drop a single entry. */
  delete(filePath: string): void {
    this.drop(filePath);
  }

  /** Drop everything. */
  clear(): void {
    this.slots.clear();
    this.meta.clear();
    // `observed` too. It is the second half of the corpus, so leaving it
    // populated made "drop everything" leave `corpusSize` non-zero and
    // `maxMtimeMs()` pinned to a file this cache no longer knows anything
    // about (Codex P2, PR #524).
    this.observed.clear();
    this.retainedBytes = 0;
  }

  /** The one place a slot leaves the map, so the byte total cannot drift. */
  private drop(filePath: string): void {
    const slot = this.slots.get(filePath);
    if (!slot) return;
    this.retainedBytes -= slot.weight;
    this.slots.delete(filePath);
  }

  /**
   * Drop every cached slot whose path is not in `liveSet`. Callers that walk
   * a known set of files (e.g. `readdir` of a session directory) can pass the
   * set in to evict slots for files that disappeared since the last sweep.
   *
   * Without this, `maxMtimeMs()` keeps reflecting the mtime of a deleted file
   * forever, which makes ETags stick to a value that no longer corresponds to
   * any real input — clients would then get 304s after a session deletion
   * even though the response body did change.
   */
  retainOnly(liveSet: Set<string>): void {
    for (const path of [...this.slots.keys()]) {
      if (!liveSet.has(path)) this.drop(path);
    }
    // The corpus index is pruned too, and this is what lets the fingerprint
    // FALL — deleting the newest transcript lowers `maxMtimeMs()`, which a
    // monotone watermark could never do.
    for (const path of [...this.meta.keys()]) {
      if (!liveSet.has(path)) this.meta.delete(path);
    }
    for (const path of [...this.observed.keys()]) {
      if (!liveSet.has(path)) this.observed.delete(path);
    }
  }

  /**
   * Max mtime across the CORPUS — every file successfully read and not since
   * removed — exposed as a side-channel so routes can compute an ETag without
   * changing parser return signatures.
   *
   * Reads `meta`, not `slots`: with `maxBytes` in play (#476) the resident set
   * is a subset of what was read, and an ETag built on residency would freeze
   * across a real change the moment the newest file was evicted.
   */
  maxMtimeMs(): number {
    let max = 0;
    for (const entry of this.meta.values()) {
      if (entry.mtimeMs > max) max = entry.mtimeMs;
    }
    // Observed-but-unread files count too. They are part of the corpus, and a
    // duplicate's alternate becoming the newest file on disk has to move this
    // — otherwise the ETag says "unchanged" across a swap that changed the
    // answer.
    for (const entry of this.observed.values()) {
      if (entry.mtimeMs > max) max = entry.mtimeMs;
    }
    return max;
  }

  /**
   * Two bounds, and each evicts by the dimension it bounds.
   *
   * **No entry is exempt, including the one just inserted.** An earlier version
   * spared it, on the reasoning that dropping it made the insert pure cost.
   * That is true and it is the lesser problem: a single transcript larger than
   * the budget would then sit above `maxBytes` after everything else had been
   * evicted, defeating the bound entirely — and any budget under 50 MB, the
   * file-size cap, can meet one. The caller already holds the returned value,
   * so evicting it costs a re-parse on the next request and nothing else,
   * while keeping it costs the guarantee. (Codex P2, PR #514.)
   */
  private evictIfNeeded(): void {
    this.evictByBytes();
    this.evictByCount();
  }

  /**
   * Size-based eviction: **largest first**, not LRU.
   *
   * This is the deliberate part (#476). The consumer that matters here is a
   * full-corpus sweep that touches every file on every pass, and for a cyclic
   * access pattern LRU is the *pessimal* policy — it evicts precisely what the
   * next pass asks for first, so the hit rate collapses to ~0 rather than
   * degrading. That is the measured 22x cliff recorded at the `parseAllSessions`
   * cache; a byte budget with an LRU policy would simply reproduce it in new
   * units the moment a corpus exceeded the budget.
   *
   * Evicting the largest entries frees the budget in the FEWEST evictions,
   * and for a sweep the hit rate follows the number of files retained rather
   * than the bytes. The reference corpus makes the difference stark: 160 files
   * (2.4%) hold 50% of the bytes, so surrendering half the budget costs 2.4%
   * of the hit rate. Under LRU it would cost most of it.
   *
   * The cost is honest and one-directional: the biggest transcripts are
   * re-parsed on every sweep once a corpus exceeds the budget. That is
   * bounded work proportional to the overshoot, against an unbounded heap.
   */
  private evictByBytes(): void {
    if (this.retainedBytes <= this.maxBytes) return;
    // Trim to 80% of the budget in one pass, the way the count sweep does.
    // Evicting only down to the line meant sorting the entire cache on EVERY
    // subsequent insert of an over-budget sweep — roughly ten thousand sorts
    // of a ten-thousand-entry array on a 2 GiB corpus of 100 KiB files, which
    // is superlinear work before any parsing cost. (Codex P2, PR #514.)
    const target = this.maxBytes * 0.8;
    const byWeightDesc = Array.from(this.slots.entries()).sort(
      (a, b) => b[1].weight - a[1].weight
    );
    for (const [path] of byWeightDesc) {
      if (this.retainedBytes <= target) return;
      this.drop(path);
    }
  }

  /**
   * LRU eviction by lastSeenAt — the runaway backstop. We trim to 80% of
   * capacity in a single sweep so we don't pay the sort cost on every insert
   * near the boundary.
   */
  private evictByCount(): void {
    if (this.slots.size <= this.maxEntries) return;
    const target = Math.floor(this.maxEntries * 0.8);
    const entries = Array.from(this.slots.entries()).sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    );
    const toEvict = this.slots.size - target;
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.drop(entries[i][0]);
    }
  }
}
