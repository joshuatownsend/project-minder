import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #430 — `verify-windows` failed on the v1.10.0 release PR with a TEARDOWN HOOK
// TIMEOUT, not an assertion, on a branch whose only diff from `main` was
// `CHANGELOG.md` and a version string. The same code had passed the same job
// thirty minutes earlier.
//
// The cause was `try { await fs.rm(...) } catch {}` in `installIsolatedState`'s
// teardown: a `catch` answers the THROW (EBUSY/EPERM) and not the STALL. On
// Windows, recursing a temp tree that still holds an open-but-closing SQLite
// handle can block past vitest's 10s hook timeout, and the hook fails before
// `fs.rm` ever settles — so the `catch` never runs.
//
// These tests drive that directly: a removal that NEVER SETTLES is the exact
// condition, and it cannot be produced by touching real files. Everything here
// is about the removal being bounded, not about the filesystem.

const rm = vi.fn();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: { ...actual.promises, rm: (...a: unknown[]) => rm(...a) },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  return (await import("./_helpers/isolatedState")).removeTempHome;
}

describe("removeTempHome (#430)", () => {
  it("returns once the removal completes", async () => {
    rm.mockResolvedValue(undefined);
    const removeTempHome = await load();
    await expect(removeTempHome("/tmp/pm-state-x")).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("gives fs.rm retries and a delay, which force:true does not supply", async () => {
    // `fs.rm` defaults to `maxRetries: 0`, and `force: true` suppresses "path
    // does not exist", NOT "path is busy" — so the old call had no backoff for
    // the transient handle it was written for.
    rm.mockResolvedValue(undefined);
    const removeTempHome = await load();
    await removeTempHome("/tmp/pm-state-x");
    expect(rm).toHaveBeenCalledWith(
      "/tmp/pm-state-x",
      expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: expect.any(Number),
        retryDelay: expect.any(Number),
      })
    );
    const opts = rm.mock.calls[0][1] as { maxRetries: number };
    expect(opts.maxRetries).toBeGreaterThan(0);
  });

  it("swallows a rejection rather than failing the hook", async () => {
    // The half the old `catch` did handle. Kept so a rewrite cannot lose it.
    rm.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    const removeTempHome = await load();
    await expect(removeTempHome("/tmp/pm-state-x")).resolves.toBeUndefined();
  });

  it("STOPS WAITING on a removal that never settles", async () => {
    // The reported failure. Under the old code this promise never resolves and
    // the hook dies at 10s; under the fix it resolves on the time budget.
    rm.mockReturnValue(new Promise(() => {}));
    const removeTempHome = await load();

    let settled = false;
    const pending = removeTempHome("/tmp/pm-state-x").then(() => {
      settled = true;
    });

    // Not before the budget...
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    // ...and well before vitest's 10s hook timeout.
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(settled).toBe(true);
  });

  it("does nothing when there is no directory to remove", async () => {
    const removeTempHome = await load();
    await expect(removeTempHome("")).resolves.toBeUndefined();
    expect(rm).not.toHaveBeenCalled();
  });
});
