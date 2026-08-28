import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileCache } from "@/lib/usage/cache";

vi.mock("fs", () => ({
  promises: {
    stat: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockStat = vi.mocked(fs.stat);

beforeEach(() => vi.clearAllMocks());

function statResult(mtimeMs: number, size: number) {
  return { mtimeMs, size } as unknown as Awaited<ReturnType<typeof fs.stat>>;
}

describe("FileCache", () => {
  it("runs the factory once and caches the result while mtime/size are stable", async () => {
    mockStat.mockResolvedValue(statResult(1000, 100));
    const cache = new FileCache<string>();
    const factory = vi.fn(async () => "parsed");

    const a = await cache.getOrCompute("/x", factory);
    const b = await cache.getOrCompute("/x", factory);

    expect(a).toBe("parsed");
    expect(b).toBe("parsed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("re-runs the factory when mtime changes", async () => {
    const cache = new FileCache<string>();
    const factory = vi.fn(async () => "v" + factory.mock.calls.length);

    mockStat.mockResolvedValueOnce(statResult(1000, 100));
    await cache.getOrCompute("/x", factory);
    mockStat.mockResolvedValueOnce(statResult(2000, 100));
    const result = await cache.getOrCompute("/x", factory);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(result).toBe("v2");
  });

  it("re-runs the factory when size changes (mtime collision)", async () => {
    const cache = new FileCache<string>();
    const factory = vi.fn(async () => "v" + factory.mock.calls.length);

    mockStat.mockResolvedValueOnce(statResult(1000, 100));
    await cache.getOrCompute("/x", factory);
    mockStat.mockResolvedValueOnce(statResult(1000, 200));
    await cache.getOrCompute("/x", factory);

    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("returns undefined and drops the entry when stat fails", async () => {
    const cache = new FileCache<string>();
    const factory = vi.fn(async () => "v");

    mockStat.mockResolvedValueOnce(statResult(1000, 100));
    await cache.getOrCompute("/x", factory);
    expect(cache.size).toBe(1);

    mockStat.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await cache.getOrCompute("/x", factory);

    expect(result).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("dedupes concurrent factory calls for the same file (single-flight)", async () => {
    mockStat.mockResolvedValue(statResult(1000, 100));
    const cache = new FileCache<string>();
    let pending: ((v: string) => void) | null = null;
    const factory = vi.fn(
      () => new Promise<string>((resolve) => { pending = resolve; })
    );

    const p1 = cache.getOrCompute("/x", factory);
    const p2 = cache.getOrCompute("/x", factory);

    // Yield once so both calls reach the in-flight registration before resolve.
    await Promise.resolve();
    expect(pending).not.toBeNull();
    pending!("parsed");

    expect(await p1).toBe("parsed");
    expect(await p2).toBe("parsed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reports max mtime across all entries", async () => {
    const cache = new FileCache<string>();
    mockStat.mockResolvedValueOnce(statResult(1000, 1));
    await cache.getOrCompute("/a", async () => "a");
    mockStat.mockResolvedValueOnce(statResult(3000, 1));
    await cache.getOrCompute("/b", async () => "b");
    mockStat.mockResolvedValueOnce(statResult(2000, 1));
    await cache.getOrCompute("/c", async () => "c");

    expect(cache.maxMtimeMs()).toBe(3000);
  });

  it("retainOnly drops slots not in the live set (deleted files)", async () => {
    const cache = new FileCache<string>();
    mockStat.mockResolvedValueOnce(statResult(1000, 1));
    await cache.getOrCompute("/keep", async () => "k");
    mockStat.mockResolvedValueOnce(statResult(9999, 1));
    await cache.getOrCompute("/drop", async () => "d");

    expect(cache.size).toBe(2);
    expect(cache.maxMtimeMs()).toBe(9999);

    cache.retainOnly(new Set(["/keep"]));

    expect(cache.size).toBe(1);
    // Deleted file's mtime no longer leaks into the freshness signal.
    expect(cache.maxMtimeMs()).toBe(1000);
  });

  it("evicts least-recently-seen entries past maxEntries", async () => {
    const cache = new FileCache<string>({ maxEntries: 3 });
    // /a, /b, /c all inserted; touch /a to keep it fresh; insert /d to overflow.
    for (const f of ["/a", "/b", "/c"]) {
      mockStat.mockResolvedValueOnce(statResult(1000, 1));
      await cache.getOrCompute(f, async () => f);
    }
    mockStat.mockResolvedValueOnce(statResult(1000, 1));
    await cache.getOrCompute("/a", async () => "a"); // refreshes /a's lastSeenAt

    mockStat.mockResolvedValueOnce(statResult(1000, 1));
    await cache.getOrCompute("/d", async () => "d");

    // floor(3 * 0.8) = 2. /a and /d should survive (most recent), /b/c evicted.
    expect(cache.size).toBe(2);
    expect(cache.maxMtimeMs()).toBeGreaterThan(0);
  });
});

// #476 — an entry count was never a memory bound. A slot holds one file's whole
// parsed value and transcript sizes span orders of magnitude: on the reference
// corpus 160 files (2.4%) hold 50% of the bytes, p50 160 KB against p99 6.7 MB
// and a 72 MB maximum. Measured alongside it, parsed `UsageTurn[]` retains
// ≈2.0x the source bytes in heap, so that corpus fully warm wants ≈5.0 GB —
// past Node's default limit, with `maxEntries: 25_000` against 5,498 files
// evicting nothing at all.
describe("FileCache byte budget (#476)", () => {
  /** Fill the cache with `n` files of `size` bytes each. */
  async function fill(
    cache: FileCache<string>,
    files: Array<[path: string, size: number]>
  ) {
    for (const [path, size] of files) {
      mockStat.mockResolvedValue(statResult(1000, size));
      await cache.getOrCompute(path, async () => path);
    }
  }

  it("tracks retained bytes as entries come and go", async () => {
    const cache = new FileCache<string>();
    await fill(cache, [["/a", 100], ["/b", 250]]);
    expect(cache.bytes).toBe(350);

    cache.delete("/a");
    expect(cache.bytes).toBe(250);

    cache.clear();
    expect(cache.bytes).toBe(0);
  });

  it("does not double-count a file that changed", async () => {
    // The drift this guards: re-inserting without subtracting the old size
    // walks the total upward until the cache evicts everything it holds.
    const cache = new FileCache<string>();
    await fill(cache, [["/a", 100]]);
    mockStat.mockResolvedValue(statResult(2000, 400));
    await cache.getOrCompute("/a", async () => "again");

    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(400);
  });

  it("subtracts the bytes of a slot dropped by retainOnly", async () => {
    const cache = new FileCache<string>();
    await fill(cache, [["/a", 100], ["/b", 250]]);
    cache.retainOnly(new Set(["/b"]));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(250);
  });

  it("evicts down to the budget once it is exceeded", async () => {
    const cache = new FileCache<string>({ maxBytes: 300 });
    await fill(cache, [["/a", 100], ["/b", 100], ["/c", 100]]);
    expect(cache.bytes).toBe(300);

    await fill(cache, [["/d", 100]]);
    expect(cache.bytes).toBeLessThanOrEqual(300);
  });

  it("evicts the LARGEST entries, not the least recently used", async () => {
    // The deliberate part. For a full-corpus sweep — every file touched on
    // every pass — LRU is the PESSIMAL policy: it evicts precisely what the
    // next pass asks for first, which is the measured 22x cliff. Largest-first
    // frees the budget in the fewest evictions, and for a sweep the hit rate
    // follows the number of files retained rather than the bytes.
    //
    // **The insertion order is the whole test.** `/big` goes in LAST of the
    // four, so it is the MOST recently used — the one LRU would keep and
    // largest-first drops. An earlier draft inserted it first, where both
    // policies pick it and the assertion held either way; the mutation check
    // (swap the comparator for `lastSeenAt`) is what exposed that.
    const cache = new FileCache<string>({ maxBytes: 1000 });
    await fill(cache, [
      ["/s1", 100],
      ["/s2", 100],
      ["/s3", 100],
      ["/big", 700],
    ]);
    expect(cache.bytes).toBe(1000);

    await fill(cache, [["/s4", 100]]);

    // Largest-first drops `/big` alone: four small files remain, 400 bytes.
    // LRU would drop `/s1` and stop at exactly 1000, keeping `/big`.
    expect(cache.size).toBe(4);
    expect(cache.bytes).toBe(400);
    expect(await cache.getOrCompute("/s1", async () => "MISS")).toBe("/s1");
  });

  it("keeps more FILES warm for the same budget than LRU would", async () => {
    // Why the policy is worth the departure, in the shape the real corpus has:
    // a few very large files alongside many small ones (160 files hold 50% of
    // the bytes there). Largest-first surrenders the big ones and keeps the
    // long tail; LRU would evict the tail to make room for the head.
    const cache = new FileCache<string>({ maxBytes: 1000 });
    const small: Array<[string, number]> = Array.from(
      { length: 9 },
      (_, i) => [`/small${i}`, 50]
    );
    await fill(cache, [...small, ["/huge", 550]]);
    expect(cache.bytes).toBe(1000);

    await fill(cache, [["/small9", 50]]);

    // 10 small files retained out of 11 entries seen; only `/huge` went.
    expect(cache.size).toBe(10);
    expect(cache.bytes).toBe(500);
    for (const [path] of small) {
      expect(await cache.getOrCompute(path, async () => "MISS")).toBe(path);
    }
  });

  it("never evicts the entry just inserted", async () => {
    // Otherwise a file larger than the budget would be parsed and immediately
    // thrown away — pure cost, and the caller still needs the value.
    const cache = new FileCache<string>({ maxBytes: 100 });
    await fill(cache, [["/small", 50]]);
    mockStat.mockResolvedValue(statResult(1000, 5000));
    const value = await cache.getOrCompute("/huge", async () => "parsed");

    expect(value).toBe("parsed");
    expect(cache.size).toBe(1);
    const again = await cache.getOrCompute("/huge", async () => "MISS");
    expect(again).toBe("parsed");
  });

  it("is unbounded by default, so existing callers are unaffected", async () => {
    const cache = new FileCache<string>();
    await fill(cache, [["/a", 10_000_000], ["/b", 10_000_000]]);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(20_000_000);
  });

  it("keeps maxEntries working as a backstop alongside the budget", async () => {
    // They bound different failure modes, so the count cap stays.
    const cache = new FileCache<string>({ maxEntries: 4, maxBytes: 1_000_000 });
    await fill(
      cache,
      Array.from({ length: 6 }, (_, i) => [`/f${i}`, 10] as [string, number])
    );
    expect(cache.size).toBeLessThanOrEqual(4);
    // And the byte total followed the count eviction rather than drifting.
    expect(cache.bytes).toBe(cache.size * 10);
  });
});
