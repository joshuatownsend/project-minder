import { describe, it, expect, vi } from "vitest";
import { initialReconcilePending, waitUntilSettled } from "@/lib/db/ingestSettled";

describe("initialReconcilePending", () => {
  const base = { useDb: true, dbUnusable: false } as const;

  it("is pending until the reconcile reports a duration", () => {
    expect(initialReconcilePending({ ...base, mode: "worker", initialReconcileMs: null })).toBe(true);
    expect(initialReconcilePending({ ...base, mode: "in-process", initialReconcileMs: null })).toBe(true);
  });

  it("is settled once a duration is reported — including a fast one", () => {
    // 0 is a real answer (an empty corpus); only null means "not reported".
    for (const ms of [0, 1, 688_654]) {
      expect(initialReconcilePending({ ...base, mode: "worker", initialReconcileMs: ms })).toBe(false);
    }
  });

  it("never waits for a reconcile that will not run", () => {
    // MINDER_INDEXER=0 → mode "off"; MINDER_USE_DB=0 → no index at all. Waiting
    // on either would hold the grade drain for the full ceiling.
    expect(initialReconcilePending({ ...base, mode: "off", initialReconcileMs: null })).toBe(false);
    expect(initialReconcilePending({ ...base, useDb: false, mode: "worker", initialReconcileMs: null })).toBe(false);
  });

  it("does not wait on an index that cannot open", () => {
    // Driver missing or the open failed: the watcher returns idle and
    // initialReconcileMs stays null forever, so waiting would burn the whole
    // ceiling — and grades come from the JSONL, so they never needed the index.
    for (const mode of ["worker", "in-process"] as const) {
      expect(initialReconcilePending({ ...base, dbUnusable: true, mode, initialReconcileMs: null })).toBe(false);
    }
  });
});

describe("waitUntilSettled", () => {
  it("returns immediately when nothing is pending", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitUntilSettled(() => false, { sleep })).resolves.toBe("settled");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls until the predicate clears, then reports settled", async () => {
    let pending = 3;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitUntilSettled(() => pending-- > 0, { pollMs: 100, maxWaitMs: 10_000, sleep });
    expect(result).toBe("settled");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("accepts an async predicate", async () => {
    let pending = 2;
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitUntilSettled(async () => pending-- > 0, { pollMs: 50, maxWaitMs: 1_000, sleep });
    expect(result).toBe("settled");
  });

  it("gives up at the ceiling instead of waiting forever", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await waitUntilSettled(() => true, { pollMs: 100, maxWaitMs: 500, sleep });
    expect(result).toBe("timed-out");
    // 500 ms ceiling at 100 ms per poll: five sleeps, then the sixth check bails.
    expect(sleep).toHaveBeenCalledTimes(5);
  });
});
