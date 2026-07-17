import { describe, it, expect, vi, beforeEach } from "vitest";

// F11: an open already in flight when the shutdown latch flips must not leave a
// live handle behind. We gate `fs.promises.mkdir` (called inside
// ensureTasksDbDir) so the opener parks mid-flight; flip the latch via
// checkpointAndCloseTasksDb(); then release. The opener's re-check of
// `shutdownClosed` (immediately before `new Database`) must bail to null — so
// better-sqlite3 is never even invoked and no handle lands in state.db.

vi.mock("server-only", () => ({}));

let mkdirGate: Promise<void>;
let releaseMkdir: () => void;

vi.mock("fs", () => ({
  promises: {
    // Returns the current gate; released manually inside each test.
    mkdir: vi.fn(() => mkdirGate),
  },
}));

import {
  getTasksDb,
  checkpointAndCloseTasksDb,
  getTasksDbSync,
  isTasksDbAvailable,
  _resetTasksDbShutdownForTesting,
} from "@/lib/tasksDb/connection";

beforeEach(() => {
  _resetTasksDbShutdownForTesting();
  mkdirGate = new Promise<void>((resolve) => {
    releaseMkdir = resolve;
  });
});

describe("getTasksDb / checkpointAndCloseTasksDb open race (F11)", () => {
  it("an open in flight when shutdown fires does not leave a live handle", async () => {
    // Opener starts and parks inside ensureTasksDbDir() (mkdir gated).
    const openP = getTasksDb();

    // Shutdown fires while the open is in flight: latch flips, then awaits the
    // in-flight open.
    const closeP = checkpointAndCloseTasksDb();

    // Release the gate; the opener resumes, re-checks the latch, and bails.
    releaseMkdir();

    const db = await openP;
    await closeP;

    expect(db).toBeNull();
    expect(getTasksDbSync()).toBeNull();
    expect(isTasksDbAvailable()).toBe(false);
  });
});
