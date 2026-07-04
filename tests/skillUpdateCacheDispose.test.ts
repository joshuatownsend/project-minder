import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process.execFile (wrapped by util.promisify in skillUpdateCache)
// so we can introduce a controllable delay between "git ls-remote started"
// and "git ls-remote returned" — that's the window the dispose() race opens
// up. execFileAsync calls execFile(file, args, options, callback); we
// capture the callback instead of invoking it immediately.
const deferredCallbacks: Array<{
  callback: (err: Error | null, result: { stdout: string; stderr: string }) => void;
}> = [];

vi.mock("child_process", () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      deferredCallbacks.push({ callback });
    }
  ),
}));

beforeEach(() => {
  deferredCallbacks.length = 0;
  vi.resetModules();
});

/** Yield to the macrotask queue so all chained microtasks (Promise.all,
 *  the awaiting processQueue() body, the writeback loop) settle. */
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function marketplaceItem(id: string, gitCommitSha: string) {
  return {
    id,
    kind: "marketplace-plugin" as const,
    marketplace: "test-marketplace",
    marketplaceRepo: "owner/repo",
    gitCommitSha,
  };
}

describe("skillUpdateCache.dispose() race protection", () => {
  it("drops in-flight batch results that land after dispose()", async () => {
    // Fresh module for each test so the singleton doesn't leak state.
    const { skillUpdateCache } = await import("@/lib/skillUpdateCache");
    skillUpdateCache.dispose();

    skillUpdateCache.enqueue([
      marketplaceItem("plugin-a", "aaa111"),
      marketplaceItem("plugin-b", "bbb222"),
    ]);

    // processQueue has spawned the batch; deferredCallbacks holds the two
    // pending `git ls-remote` subprocess callbacks. They haven't fired yet.
    expect(deferredCallbacks.length).toBe(2);
    expect(skillUpdateCache.total).toBe(0);

    // Something (e.g. a feature-flag flip or HMR reload) disposes the cache
    // while the subprocesses are still in flight.
    skillUpdateCache.dispose();

    // The pending subprocesses now resolve with a HEAD sha that differs from
    // gitCommitSha — enough to mark hasUpdate:true if the write lands.
    deferredCallbacks[0].callback(null, { stdout: "deadbeef00deadbeef00deadbeef00deadbeef0\tHEAD\n", stderr: "" });
    deferredCallbacks[1].callback(null, { stdout: "deadbeef00deadbeef00deadbeef00deadbeef0\tHEAD\n", stderr: "" });

    await flushAsync();

    // Without the generation guard, processQueue would write these into the
    // cache we just cleared. With the guard, the batch is silently dropped.
    expect(skillUpdateCache.total).toBe(0);
    expect(skillUpdateCache.get("plugin-a")).toBeNull();
    expect(skillUpdateCache.get("plugin-b")).toBeNull();
  });

  it("a fresh enqueue after dispose() works normally", async () => {
    const { skillUpdateCache } = await import("@/lib/skillUpdateCache");
    skillUpdateCache.dispose();

    skillUpdateCache.enqueue([marketplaceItem("plugin-c", "ccc333")]);
    expect(deferredCallbacks.length).toBe(1);
    deferredCallbacks[0].callback(null, {
      stdout: "ccc333ccc333ccc333ccc333ccc333ccc333cc\tHEAD\n",
      stderr: "",
    });
    await flushAsync();
    expect(skillUpdateCache.get("plugin-c")).not.toBeNull();

    skillUpdateCache.dispose();
    expect(skillUpdateCache.get("plugin-c")).toBeNull();
    expect(skillUpdateCache.total).toBe(0);

    deferredCallbacks.length = 0;
    skillUpdateCache.enqueue([marketplaceItem("plugin-d", "ddd444")]);
    expect(deferredCallbacks.length).toBe(1);
    deferredCallbacks[0].callback(null, {
      stdout: "ddd444ddd444ddd444ddd444ddd444ddd444dd\tHEAD\n",
      stderr: "",
    });
    await flushAsync();
    expect(skillUpdateCache.get("plugin-d")).not.toBeNull();
  });

  it("dispose() forgets known items — unlike refresh(), it does not re-enqueue", async () => {
    const { skillUpdateCache } = await import("@/lib/skillUpdateCache");
    skillUpdateCache.dispose();

    skillUpdateCache.enqueue([marketplaceItem("plugin-e", "eee555")]);
    deferredCallbacks[0].callback(null, {
      stdout: "eee555eee555eee555eee555eee555eee555ee\tHEAD\n",
      stderr: "",
    });
    await flushAsync();
    expect(skillUpdateCache.get("plugin-e")).not.toBeNull();

    deferredCallbacks.length = 0;
    skillUpdateCache.dispose();

    // No re-enqueue happens on dispose (contrast with refresh()), so no new
    // subprocess should have been spawned.
    expect(deferredCallbacks.length).toBe(0);
    expect(skillUpdateCache.pending).toBe(0);
    expect(skillUpdateCache.total).toBe(0);
  });
});
