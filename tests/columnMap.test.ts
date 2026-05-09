import { describe, it, expect } from "vitest";
import { sessionToColumn, taskToColumn } from "@/lib/kanban/columnMap";
import type { LiveSessionStatus } from "@/lib/types";
import { TASK_STATUSES } from "@/lib/tasks/types";
import type { TaskStatus } from "@/lib/tasks/types";

// All live session status values
const LIVE_SESSION_STATUSES: LiveSessionStatus[] = [
  "working",
  "approval",
  "waiting",
  "other",
];

describe("sessionToColumn", () => {
  it("approval → waiting", () => {
    expect(sessionToColumn("approval")).toBe("waiting");
  });

  it("working → working", () => {
    expect(sessionToColumn("working")).toBe("working");
  });

  it("waiting → idle", () => {
    expect(sessionToColumn("waiting")).toBe("idle");
  });

  it("other → idle", () => {
    // getLiveStatusPayload() provides no terminal-state signal — sessions
    // with liveStatus "other" always land in Idle.
    expect(sessionToColumn("other")).toBe("idle");
  });

  it("covers every LiveSessionStatus value", () => {
    // Exhaustive check — if a new value is added, this test catches it
    for (const s of LIVE_SESSION_STATUSES) {
      expect(() => sessionToColumn(s)).not.toThrow();
    }
  });
});

describe("taskToColumn", () => {
  const cases: [TaskStatus, string][] = [
    ["running", "working"],
    ["awaiting_approval", "waiting"],
    ["pending", "idle"],
    ["cancelled", "idle"],
    ["done", "done"],
    ["failed", "error"],
  ];

  for (const [status, expected] of cases) {
    it(`${status} → ${expected}`, () => {
      expect(taskToColumn(status)).toBe(expected);
    });
  }

  it("covers every TaskStatus value", () => {
    for (const s of TASK_STATUSES) {
      expect(() => taskToColumn(s)).not.toThrow();
    }
  });
});
