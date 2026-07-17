import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// F13: getLiveDispatchSnapshot() classifies PID markers so an UPGRADE doesn't
// mis-key a still-alive task. Filename = PID; body is `task:<id>` (new),
// a bare PID copy (legacy pre-upgrade), or corrupt. We mock the fs reads and
// process.kill liveness so classification is deterministic.

vi.mock("server-only", () => ({}));
// spawner uses `import fs from "fs"` (default). Also stub the store to keep the
// tasksDb/better-sqlite3 chain out of this focused test.
vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));
vi.mock("../src/lib/tasks/store", () => ({
  completeTask: vi.fn(),
  failTask: vi.fn(),
  setSessionId: vi.fn(),
  getTask: vi.fn(),
}));

import fs from "fs";
import { getLiveDispatchSnapshot } from "../src/lib/tasks/spawner";

const readdirSync = vi.mocked(fs.readdirSync);
const readFileSync = vi.mocked(fs.readFileSync);

let killSpy: ReturnType<typeof vi.spyOn>;

// PIDs treated as alive; every other pid throws ESRCH like a dead process.
function setAlive(pids: number[]) {
  const alive = new Set(pids);
  killSpy.mockImplementation(((pid: number) => {
    if (alive.has(pid)) return true;
    throw new Error("ESRCH");
  }) as never);
}

// Map filename (pid) → body.
function setMarkers(bodies: Record<string, string>) {
  readdirSync.mockReturnValue(Object.keys(bodies) as never);
  readFileSync.mockImplementation(((p: string) => {
    for (const [name, body] of Object.entries(bodies)) {
      if (String(p).endsWith(name)) return body;
    }
    return "";
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  killSpy = vi.spyOn(process, "kill");
});

afterEach(() => {
  killSpy.mockRestore();
});

describe("getLiveDispatchSnapshot marker classification (F13)", () => {
  it("maps live NEW-format `task:<id>` markers to task ids", () => {
    setMarkers({ "1001": "task:55", "1002": "task:56" });
    setAlive([1001, 1002]);

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds).toEqual(new Set([55, 56]));
    expect(snap.hasUnmappedLive).toBe(false);
  });

  it("flags a live LEGACY marker (body == filename PID) as unmapped, attributing no task", () => {
    setMarkers({ "1001": "1001" }); // legacy: body is the PID
    setAlive([1001]);

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds.size).toBe(0);
    expect(snap.hasUnmappedLive).toBe(true);
  });

  it("flags a live CORRUPT marker as unmapped", () => {
    setMarkers({ "1001": "garbage-not-a-marker" });
    setAlive([1001]);

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds.size).toBe(0);
    expect(snap.hasUnmappedLive).toBe(true);
  });

  it("ignores markers whose PID is dead (leaves them for sweepStalePids)", () => {
    setMarkers({ "1001": "task:55", "1002": "1002" }); // 1002 legacy, but dead
    setAlive([1001]); // only 1001 alive

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds).toEqual(new Set([55]));
    expect(snap.hasUnmappedLive).toBe(false); // the dead legacy marker doesn't count
  });

  it("mixes new + live-legacy: maps the new id AND flags unmapped", () => {
    setMarkers({ "1001": "task:55", "1002": "1002" }); // both alive
    setAlive([1001, 1002]);

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds).toEqual(new Set([55]));
    expect(snap.hasUnmappedLive).toBe(true);
  });

  it("treats a malformed `task:` body (non-numeric) as unmapped", () => {
    setMarkers({ "1001": "task:abc" });
    setAlive([1001]);

    const snap = getLiveDispatchSnapshot();
    expect(snap.taskIds.size).toBe(0);
    expect(snap.hasUnmappedLive).toBe(true);
  });
});
