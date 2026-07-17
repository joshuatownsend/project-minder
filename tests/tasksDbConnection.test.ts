import { describe, it, expect, vi } from "vitest";

// The connection module is `server-only`; stub it so the module loads under vitest.
vi.mock("server-only", () => ({}));

import {
  checkpointAndCloseTasksDb,
  getTasksDbSync,
  isTasksDbAvailable,
} from "@/lib/tasksDb/connection";

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
