import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Integration coverage for the embedding self-heal hook on the dispatcher tick.
 *
 * `selfHeal.ts` unit tests prove the *policy*; these prove the dispatcher
 * actually consults it and calls the backfill — the wiring, which is the part
 * that has historically shipped missing while its documentation shipped
 * complete.
 *
 * Lives in its own file rather than in `tasksDispatcher.test.ts` because it has
 * to mock `config`, `db/connection` and `embeddings/backfill`, and a module
 * mock is file-wide.
 */

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  backfill: vi.fn(),
  db: { fake: true } as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock("../src/lib/config", () => ({
  readConfig: vi.fn(async () => ({ featureFlags: h.flags })),
}));
vi.mock("../src/lib/quota", () => ({
  loadQuota: vi.fn(async () => null),
}));
vi.mock("../src/lib/db/connection", () => ({
  getDb: vi.fn(async () => h.db),
}));
vi.mock("../src/lib/embeddings/backfill", () => ({
  runEmbeddingBackfill: h.backfill,
}));

vi.mock("../src/lib/tasks/store", () => ({
  claimPendingTask: vi.fn().mockResolvedValue(null),
  materializeSchedules: vi.fn().mockResolvedValue(0),
  promoteApprovalTasks: vi.fn().mockResolvedValue(0),
  completeTask: vi.fn().mockResolvedValue(undefined),
  recordDecision: vi.fn().mockResolvedValue(undefined),
  getTask: vi.fn().mockResolvedValue(null),
  updateSwarmStatus: vi.fn().mockResolvedValue(undefined),
  requeueRunningTask: vi.fn().mockResolvedValue(null),
  failTask: vi.fn().mockResolvedValue({ id: 0, status: "failed" }),
  listRunningTasks: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/lib/tasks/todoDelegation", () => ({
  onTaskCompleteToggleTodo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tasks/boardDelegation", () => ({
  onTaskCompleteSyncBoard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tasks/spawner", () => ({
  sweepStalePids: vi.fn(),
  runClassicTask: vi.fn().mockResolvedValue({ taskId: 1, status: "done", durationMs: 100 }),
  getLiveDispatchSnapshot: vi.fn(() => ({ taskIds: new Set<number>(), hasUnmappedLive: false })),
}));

import { initDispatcher } from "../src/lib/tasks/dispatcher";
import { SELF_HEAL_CHUNKS, IDLE_COOLDOWN_TICKS } from "../src/lib/embeddings/selfHeal";

function cleanupDispatcher() {
  const g = globalThis as Record<string, unknown>;
  const handle = g.__minderDispatcher as { dispose?: () => void } | undefined;
  if (handle?.dispose) handle.dispose();
  delete g.__minderDispatcher;
}

/** Let the detached self-heal promise settle — the tick does not await it. */
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const PASS = { embedded: SELF_HEAL_CHUNKS, remaining: 5_000, total: 100_000, model: "m", durationMs: 100 };

describe("dispatcher embedding self-heal", () => {
  beforeEach(() => {
    cleanupDispatcher();
    vi.useFakeTimers();
    vi.clearAllMocks();
    h.flags = { semanticSearch: true, semanticAutoBackfill: true, quotaAwareDispatch: false };
    h.backfill.mockResolvedValue(PASS);
  });

  afterEach(() => {
    cleanupDispatcher();
    vi.useRealTimers();
  });

  async function firstTick() {
    initDispatcher();
    await vi.advanceTimersByTimeAsync(2_100);
    await settle();
  }

  it("runs a bounded pass on an idle tick when both flags are on", async () => {
    await firstTick();
    expect(h.backfill).toHaveBeenCalledTimes(1);
    expect(h.backfill).toHaveBeenCalledWith(h.db, SELF_HEAL_CHUNKS);
  });

  it("does nothing when the auto-backfill flag is off", async () => {
    h.flags = { semanticSearch: true, semanticAutoBackfill: false, quotaAwareDispatch: false };
    await firstTick();
    expect(h.backfill).not.toHaveBeenCalled();
  });

  // Topping up an index that no search path consults is pure waste.
  it("does nothing when semantic search itself is off", async () => {
    h.flags = { semanticSearch: false, semanticAutoBackfill: true, quotaAwareDispatch: false };
    await firstTick();
    expect(h.backfill).not.toHaveBeenCalled();
  });

  it("defaults to off on a config with no flags set", async () => {
    h.flags = {};
    await firstTick();
    expect(h.backfill).not.toHaveBeenCalled();
  });

  it("comes straight back while passes are still making progress", async () => {
    await firstTick();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.backfill).toHaveBeenCalledTimes(2);
  });

  it("backs off after a pass reports nothing to do", async () => {
    h.backfill.mockResolvedValue({ ...PASS, embedded: 0, remaining: 0, stoppedBecause: "nothing-to-do" });
    await firstTick();
    expect(h.backfill).toHaveBeenCalledTimes(1);

    // Every tick inside the cooldown window must stay quiet.
    for (let i = 0; i < IDLE_COOLDOWN_TICKS - 1; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
    }
    expect(h.backfill).toHaveBeenCalledTimes(1);

    // …and the window must actually end, rather than latching off.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.backfill).toHaveBeenCalledTimes(2);
  });

  it("recovers from a rejecting pass instead of latching off", async () => {
    // `running` left set by a throw would kill self-heal for the life of the
    // process. Silently — which is the reason this test exists.
    h.backfill.mockRejectedValueOnce(new Error("db closed")).mockResolvedValue(PASS);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await firstTick();
    expect(h.backfill).toHaveBeenCalledTimes(1);

    // An error backs off longer than idle; step past it and confirm it resumes.
    for (let i = 0; i < 41; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await settle();
    }
    expect(h.backfill.mock.calls.length).toBeGreaterThan(1);
    consoleError.mockRestore();
  });

  it("does not block the tick on a slow pass", async () => {
    // The pass is detached: a tick must complete even while one hangs, or a
    // slow first model load would stall task dispatch behind it.
    let release: (v: unknown) => void = () => {};
    h.backfill.mockReturnValueOnce(new Promise((r) => { release = r; }));
    await firstTick();
    expect(h.backfill).toHaveBeenCalledTimes(1);

    // Next tick still runs (and correctly declines to start a second pass).
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.backfill).toHaveBeenCalledTimes(1);

    release(PASS);
    await settle();
  });
});
