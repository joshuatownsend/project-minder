import { describe, it, expect, vi, afterEach } from "vitest";

// The connection module is `server-only`; stub it so the module loads under vitest.
vi.mock("server-only", () => ({}));

import {
  checkpointAndCloseTasksDb,
  getTasksDb,
  getTasksDbSync,
  isTasksDbAvailable,
  isTasksDbShutdownClosed,
  _resetTasksDbShutdownForTesting,
} from "@/lib/tasksDb/connection";

// The shutdown latch is process-lifetime sticky; clear it between cases so one
// test's close doesn't leak into the next.
afterEach(() => {
  _resetTasksDbShutdownForTesting();
});

// `checkpointAndCloseTasksDb()` (A2 graceful shutdown) operates on the module
// singleton, which points at ~/.minder/tasks.db — the test suite never opens it
// (all other tasksDb tests use :memory: handles), so here the connection is
// closed. That's exactly the better-sqlite3-absent / DB-not-open degrade path
// the shutdown disposer must tolerate: it has to be a clean, throw-free no-op.
describe("checkpointAndCloseTasksDb (graceful-shutdown close, degrade path)", () => {
  it("is a safe no-op when no connection is open", () => {
    expect(getTasksDbSync()).toBeNull();
    expect(isTasksDbAvailable()).toBe(false);

    expect(() => checkpointAndCloseTasksDb()).not.toThrow();

    // Still nothing open afterwards — no handle was conjured.
    expect(getTasksDbSync()).toBeNull();
    expect(isTasksDbAvailable()).toBe(false);
  });

  it("stays a no-op across repeated calls (idempotent)", () => {
    expect(() => {
      checkpointAndCloseTasksDb();
      checkpointAndCloseTasksDb();
    }).not.toThrow();
    expect(isTasksDbAvailable()).toBe(false);
  });
});

// F10: a task's completeTask/failTask can fire after the child exits, which is
// after the shutdown disposer closed tasks.db. getTasksDb() must NOT re-open the
// DB in that window — otherwise a fresh handle is resurrected mid-process-exit.
describe("getTasksDb after shutdown close (F10)", () => {
  it("latches closed and refuses to re-open the DB", async () => {
    expect(isTasksDbShutdownClosed()).toBe(false);

    checkpointAndCloseTasksDb(); // latch closed (no open handle → close is a no-op)
    expect(isTasksDbShutdownClosed()).toBe(true);

    // The key guarantee: no re-open. Would previously have constructed a fresh
    // Database at TASKS_DB_PATH; now it stays null.
    await expect(getTasksDb()).resolves.toBeNull();
    expect(getTasksDbSync()).toBeNull();
    expect(isTasksDbAvailable()).toBe(false);
  });

  it("_resetTasksDbShutdownForTesting clears the latch", () => {
    checkpointAndCloseTasksDb();
    expect(isTasksDbShutdownClosed()).toBe(true);
    _resetTasksDbShutdownForTesting();
    expect(isTasksDbShutdownClosed()).toBe(false);
  });
});
