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
}

export interface FileCacheOptions {
  /** Maximum entries before LRU eviction kicks in. Default: 5000. */
  maxEntries?: number;
}

export class FileCache<T> {
  private readonly slots = new Map<string, CacheSlot<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;

  constructor(opts: FileCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 5000;
  }

  /** Number of cached entries (for tests and metrics). */
  get size(): number {
    return this.slots.size;
  }

  /**
   * Returns the cached value if the file's mtime and size are unchanged,
   * otherwise runs `factory(filePath)`, stores the result, and returns it.
   * Returns `undefined` if the file can't be stat'd (deleted, permission, etc.)
   * — the caller decides whether absence is fatal.
   */
  async getOrCompute(
    filePath: string,
    factory: (filePath: string) => Promise<T>
  ): Promise<T | undefined> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // File gone — drop any cached entry so we don't return stale data later.
      this.slots.delete(filePath);
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
      const value = await factory(filePath);
      this.slots.set(filePath, { mtimeMs, size, value, lastSeenAt: Date.now() });
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
    this.slots.delete(filePath);
  }

  /** Drop everything. */
  clear(): void {
    this.slots.clear();
  }

  /**
   * Max mtime across all currently cached entries — exposed as a side-channel
   * so routes can compute an ETag without changing parser return signatures.
   */
  maxMtimeMs(): number {
    let max = 0;
    for (const slot of this.slots.values()) {
      if (slot.mtimeMs > max) max = slot.mtimeMs;
    }
    return max;
  }

  /**
   * LRU eviction by lastSeenAt. We trim to 80% of capacity in a single sweep
   * so we don't pay the sort cost on every insert near the boundary.
   */
  private evictIfNeeded(): void {
    if (this.slots.size <= this.maxEntries) return;
    const target = Math.floor(this.maxEntries * 0.8);
    const entries = Array.from(this.slots.entries()).sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    );
    const toEvict = entries.length - target;
    for (let i = 0; i < toEvict; i++) {
      this.slots.delete(entries[i][0]);
    }
  }
}
