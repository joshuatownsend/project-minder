import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock scanGitDirtyStatus so we can introduce a controllable delay between
// "git subprocess started" and "git subprocess returned" — that's the
// window the dispose() race opens up.
const deferredResults: Array<{
  resolve: (value: { isDirty: boolean; uncommittedCount: number }) => void;
}> = [];

vi.mock("@/lib/scanner/git", () => ({
  scanGitDirtyStatus: vi.fn(() => {
    return new Promise((resolve) => {
      deferredResults.push({ resolve });
    });
  }),
}));

beforeEach(() => {
  deferredResults.length = 0;
  vi.resetModules();
});

/** Yield to the macrotask queue so all chained microtasks (Promise.all,
 *  the awaiting processQueue() body, the writeback loop) settle. Two
 *  `await Promise.resolve()` aren't enough to drain a Promise.all in an
 *  async function. */
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("gitStatusCache.dispose() race protection", () => {
  it("drops in-flight batch results that land after dispose()", async () => {
    // Fresh module for each test so the singleton doesn't leak state.
    const { gitStatusCache } = await import("@/lib/gitStatusCache");
    gitStatusCache.dispose();

    gitStatusCache.enqueue([
      { slug: "alpha", path: "/repo/alpha" },
      { slug: "beta", path: "/repo/beta" },
    ]);

    // processQueue has spawned the batch; deferredResults holds the two
    // pending git subprocess promises. They haven't resolved yet.
    expect(deferredResults.length).toBe(2);
    expect(gitStatusCache.total).toBe(0);

    // User flips the feature flag → dispose() runs while subprocesses are
    // still in flight.
    gitStatusCache.dispose();

    // The pending git subprocesses now resolve. Without the generation
    // guard, processQueue would write these into the cache we just
    // cleared. With the guard, the batch is silently dropped.
    deferredResults[0].resolve({ isDirty: false, uncommittedCount: 0 });
    deferredResults[1].resolve({ isDirty: true, uncommittedCount: 3 });

    await flushAsync();

    expect(gitStatusCache.total).toBe(0);
    expect(gitStatusCache.get("alpha")).toBeNull();
    expect(gitStatusCache.get("beta")).toBeNull();
  });

  it("a fresh enqueue after dispose() works normally", async () => {
    const { gitStatusCache } = await import("@/lib/gitStatusCache");
    gitStatusCache.dispose();

    gitStatusCache.enqueue([{ slug: "gamma", path: "/repo/gamma" }]);
    expect(deferredResults.length).toBe(1);
    deferredResults[0].resolve({ isDirty: true, uncommittedCount: 1 });
    await flushAsync();
    expect(gitStatusCache.get("gamma")).toMatchObject({ isDirty: true, uncommittedCount: 1 });

    gitStatusCache.dispose();
    expect(gitStatusCache.get("gamma")).toBeNull();

    deferredResults.length = 0;
    gitStatusCache.enqueue([{ slug: "delta", path: "/repo/delta" }]);
    expect(deferredResults.length).toBe(1);
    deferredResults[0].resolve({ isDirty: false, uncommittedCount: 0 });
    await flushAsync();
    expect(gitStatusCache.get("delta")).toMatchObject({ isDirty: false, uncommittedCount: 0 });
  });
});
