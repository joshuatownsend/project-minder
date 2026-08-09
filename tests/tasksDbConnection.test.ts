import { describe, it, expect, vi } from "vitest";
import { installIsolatedState } from "./_helpers/isolatedState";

// The connection module is `server-only`; stub it so the module loads under vitest.
vi.mock("server-only", () => ({}));

// This file used to import `@/lib/tasksDb/connection` STATICALLY, which binds
// `TASKS_DB_PATH` to the developer's real `~/.minder/tasks.db` at import time.
// It was safe only by argument: none of the calls below open a connection, so
// the path was never used. That is a property of the code under test, asserted
// nowhere — if `getTasksDb()` ever regressed into opening eagerly, this suite
// would have opened and checkpointed the developer's real tasks database
// instead of failing (#331).
//
// Isolating removes the argument. `TASKS_DB_PATH` now resolves under a temp
// home, so the regression this file exists to catch shows up as a failed
// assertion rather than as a side effect on real data.
//
// `__minderTasksDb` holds the module's shutdown latch and handle slot on
// `globalThis` (it survives Next.js HMR by design), so `vi.resetModules()`
// alone would carry a flipped latch from one test into the next — hence the
// explicit `extraGlobals`. It replaces the `_resetTasksDbShutdownForTesting()`
// that used to run in `afterEach`.
const state = installIsolatedState({
  prefix: "pm-tasksdb-",
  extraGlobals: ["__minderTasksDb"],
});

async function loadConnection() {
  await state.reload();
  return import("@/lib/tasksDb/connection");
}

// `checkpointAndCloseTasksDb()` (A2 graceful shutdown) operates on the module
// singleton. The suite never opens that database (all other tasksDb tests use
// :memory: handles), so here the connection is closed. That's exactly the
// better-sqlite3-absent / DB-not-open degrade path the shutdown disposer must
// tolerate: it has to be a clean, throw-free no-op.
describe("checkpointAndCloseTasksDb (graceful-shutdown close, degrade path)", () => {
  it("is a safe no-op when no connection is open", async () => {
    const conn = await loadConnection();
    expect(conn.getTasksDbSync()).toBeNull();
    expect(conn.isTasksDbAvailable()).toBe(false);

    await expect(conn.checkpointAndCloseTasksDb()).resolves.toBeUndefined();

    // Still nothing open afterwards — no handle was conjured.
    expect(conn.getTasksDbSync()).toBeNull();
    expect(conn.isTasksDbAvailable()).toBe(false);
  });

  it("stays a no-op across repeated calls (idempotent)", async () => {
    const conn = await loadConnection();
    await conn.checkpointAndCloseTasksDb();
    await conn.checkpointAndCloseTasksDb();
    expect(conn.isTasksDbAvailable()).toBe(false);
  });
});

// F10: a task's completeTask/failTask can fire after the child exits, which is
// after the shutdown disposer closed tasks.db. getTasksDb() must NOT re-open the
// DB in that window — otherwise a fresh handle is resurrected mid-process-exit.
describe("getTasksDb after shutdown close (F10)", () => {
  it("latches closed and refuses to re-open the DB", async () => {
    const conn = await loadConnection();
    expect(conn.isTasksDbShutdownClosed()).toBe(false);

    await conn.checkpointAndCloseTasksDb(); // latch closed (no open handle → close is a no-op)
    expect(conn.isTasksDbShutdownClosed()).toBe(true);

    // The key guarantee: no re-open. Would previously have constructed a fresh
    // Database at TASKS_DB_PATH; now it stays null.
    await expect(conn.getTasksDb()).resolves.toBeNull();
    expect(conn.getTasksDbSync()).toBeNull();
    expect(conn.isTasksDbAvailable()).toBe(false);
  });

  it("_resetTasksDbShutdownForTesting clears the latch", async () => {
    const conn = await loadConnection();
    // Opens with the latch already clear even though the case above left it
    // flipped. That is what replaced the old
    // `afterEach(_resetTasksDbShutdownForTesting)`: the latch is fresh because
    // the helper drops `__minderTasksDb`, not because a teardown hook
    // remembered to unset it. Fails if `extraGlobals` is dropped.
    expect(conn.isTasksDbShutdownClosed()).toBe(false);

    await conn.checkpointAndCloseTasksDb();
    expect(conn.isTasksDbShutdownClosed()).toBe(true);
    conn._resetTasksDbShutdownForTesting();
    expect(conn.isTasksDbShutdownClosed()).toBe(false);
  });
});
