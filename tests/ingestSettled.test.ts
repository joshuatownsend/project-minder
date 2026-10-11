import { describe, it, expect, vi, afterEach } from "vitest";

// The live reader imports these on demand. Stubbed so the regression test below
// controls exactly what "ingest is running but has not reported" looks like,
// without starting a watcher or touching a database.
const workerStatus = vi.hoisted(() => ({
  running: false,
  pausedUntil: null as number | null,
  watcher: null as { initialReconcileMs: number | null } | null,
}));
const inProcess = vi.hoisted(() => ({ initialReconcileMs: null as number | null, unusable: false }));
vi.mock("@/lib/db/workerHost", () => ({
  getWorkerStatus: () => workerStatus,
}));
vi.mock("@/lib/db/ingestWatcher", () => ({
  getWatcherStatus: () => ({ initialReconcileMs: inProcess.initialReconcileMs }),
  isIndexUnusable: () => inProcess.unusable,
}));

import {
  initialReconcilePending,
  readIndexCurrent,
  readInitialReconcilePending,
  waitUntilSettled,
} from "@/lib/db/ingestSettled";

describe("initialReconcilePending", () => {
  const base = { dbUnusable: false } as const;

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
    // MINDER_INDEXER=0 → mode "off": nothing will ever report, so waiting would
    // hold the grade drain for the full ceiling.
    expect(initialReconcilePending({ ...base, mode: "off", initialReconcileMs: null })).toBe(false);
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

describe("readInitialReconcilePending", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Codex, PR #587: MINDER_USE_DB=0 switches the READ backend, not index
  // maintenance. Pure file-parse mode needs MINDER_INDEXER=0 as well, so with
  // USE_DB=0 alone the watcher still starts and the reconcile still runs — a
  // sweep that skipped the wait there would land on top of it.
  it("still waits for the reconcile when only MINDER_USE_DB=0", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MINDER_DEMO", "");
    vi.stubEnv("MINDER_INDEXER", "");
    vi.stubEnv("MINDER_USE_DB", "0");
    await expect(readInitialReconcilePending()).resolves.toBe(true);
  });

  it("does not wait while ingest is paused after heap-ceiling crashes (#656)", async () => {
    // Codex, PR #668: the cooldown leaves no reconcile running, so the grade
    // sweep must not sit out the 30 min settle ceiling waiting for one.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MINDER_DEMO", "");
    vi.stubEnv("MINDER_INDEXER", "");
    workerStatus.pausedUntil = Date.now() + 60_000;
    try {
      await expect(readInitialReconcilePending()).resolves.toBe(false);
    } finally {
      workerStatus.pausedUntil = null;
    }
  });

  it("does not wait when the indexer itself is off (MINDER_INDEXER=0)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MINDER_DEMO", "");
    vi.stubEnv("MINDER_INDEXER", "0");
    await expect(readInitialReconcilePending()).resolves.toBe(false);
  });
});

// #672 (Codex, PR #673): live status skips transcripts on the index's word, so
// it may only do that once this boot's initial reconcile has caught the index up
// with every transcript written while Minder was stopped.
describe("readIndexCurrent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    Object.assign(workerStatus, { running: false, pausedUntil: null, watcher: null });
    Object.assign(inProcess, { initialReconcileMs: null, unusable: false });
  });

  it("is current once the running worker's initial reconcile has finished", async () => {
    workerStatus.running = true;
    workerStatus.watcher = { initialReconcileMs: null };
    await expect(readIndexCurrent()).resolves.toBe(false); // started, not finished
    workerStatus.watcher = { initialReconcileMs: 12_000 };
    await expect(readIndexCurrent()).resolves.toBe(true);
  });

  it("is not current while a worker is spawned but has not reported", async () => {
    workerStatus.running = true;
    inProcess.initialReconcileMs = 5_000; // a stale in-process reading must not count
    await expect(readIndexCurrent()).resolves.toBe(false);
  });

  it("reads the in-process watcher when no worker runs", async () => {
    await expect(readIndexCurrent()).resolves.toBe(false);
    inProcess.initialReconcileMs = 0;
    await expect(readIndexCurrent()).resolves.toBe(true);
  });

  it("is not current while ingest is paused after crashes", async () => {
    workerStatus.running = true;
    workerStatus.watcher = { initialReconcileMs: 12_000 };
    workerStatus.pausedUntil = Date.now() + 60_000;
    await expect(readIndexCurrent()).resolves.toBe(false);
  });

  it("is not current with the index unusable or the indexer off", async () => {
    inProcess.initialReconcileMs = 1_000;
    inProcess.unusable = true;
    await expect(readIndexCurrent()).resolves.toBe(false);
    inProcess.unusable = false;
    vi.stubEnv("MINDER_INDEXER", "0");
    await expect(readIndexCurrent()).resolves.toBe(false);
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
