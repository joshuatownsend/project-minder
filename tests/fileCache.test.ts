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
