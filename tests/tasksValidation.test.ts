import { describe, it, expect } from "vitest";
import {
  validateCreateTask,
  validatePatchTask,
  validateCreateSchedule,
  validatePatchSchedule,
} from "@/lib/tasks/validation";

// ---------------------------------------------------------------------------
// validateCreateTask
// ---------------------------------------------------------------------------

describe("validateCreateTask", () => {
  it("rejects null body", () => {
    const r = validateCreateTask(null);
    expect("error" in r).toBe(true);
  });

  it("rejects body with no title", () => {
    const r = validateCreateTask({});
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("title");
  });

  it("rejects empty title", () => {
    const r = validateCreateTask({ title: "   " });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("title");
  });

  it("accepts minimal body with title only", () => {
    const r = validateCreateTask({ title: "Test task" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.title).toBe("Test task");
  });

  it("trims title whitespace", () => {
    const r = validateCreateTask({ title: "  hello  " });
    if (!("error" in r)) expect(r.title).toBe("hello");
  });

  it("rejects priority out of range", () => {
    const r = validateCreateTask({ title: "t", priority: 6 });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("priority");
  });

  it("accepts priority 1–5", () => {
    for (const p of [1, 2, 3, 4, 5]) {
      const r = validateCreateTask({ title: "t", priority: p });
      expect("error" in r).toBe(false);
    }
  });

  it("rejects unknown quadrant", () => {
    const r = validateCreateTask({ title: "t", quadrant: "unknown" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("quadrant");
  });

  it("accepts valid quadrants", () => {
    for (const q of ["do", "schedule", "delegate", "archive"]) {
      const r = validateCreateTask({ title: "t", quadrant: q });
      expect("error" in r).toBe(false);
    }
  });

  it("rejects invalid execution_mode", () => {
    const r = validateCreateTask({ title: "t", execution_mode: "turbo" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("execution_mode");
  });

  it("rejects invalid risk_level", () => {
    const r = validateCreateTask({ title: "t", risk_level: "extreme" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("risk_level");
  });

  it("rejects non-boolean requires_approval", () => {
    const r = validateCreateTask({ title: "t", requires_approval: "yes" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("requires_approval");
  });

  it("threads a metadata object through (workflow launcher needs projectPath as cwd)", () => {
    const meta = { projectPath: "C:\\dev\\minder", source: "workflow-launcher", launcherId: "review-diff" };
    const r = validateCreateTask({ title: "t", metadata: meta });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.metadata).toEqual(meta);
  });

  it("omits metadata when absent", () => {
    const r = validateCreateTask({ title: "t" });
    if (!("error" in r)) expect(r.metadata).toBeUndefined();
  });

  it("rejects array metadata (must be a plain object)", () => {
    const r = validateCreateTask({ title: "t", metadata: [1, 2] });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("metadata");
  });

  it("rejects non-string metadata.projectPath", () => {
    const r = validateCreateTask({ title: "t", metadata: { projectPath: 42 } });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("metadata.projectPath");
  });

  it("treats null metadata as absent", () => {
    const r = validateCreateTask({ title: "t", metadata: null });
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validatePatchTask — status-transition matrix
// ---------------------------------------------------------------------------

describe("validatePatchTask status transitions", () => {
  const legal: Array<[string, string]> = [
    ["pending", "awaiting_approval"],
    ["pending", "running"],
    ["pending", "cancelled"],
    ["awaiting_approval", "pending"],
    ["awaiting_approval", "cancelled"],
    ["running", "done"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["failed", "pending"],
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} → ${to}`, () => {
      const r = validatePatchTask({ status: to }, from as any);
      expect("error" in r).toBe(false);
    });
  }

  const illegal: Array<[string, string]> = [
    ["pending", "done"],
    ["pending", "failed"],
    ["done", "pending"],
    ["done", "running"],
    ["done", "failed"],
    ["cancelled", "pending"],
    ["cancelled", "running"],
  ];

  for (const [from, to] of illegal) {
    it(`rejects ${from} → ${to}`, () => {
      const r = validatePatchTask({ status: to }, from as any);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.field).toBe("status");
    });
  }

  it("allows same-status PATCH (no-op transition)", () => {
    const r = validatePatchTask({ status: "pending" }, "pending");
    expect("error" in r).toBe(false);
  });

  it("rejects unknown status value", () => {
    const r = validatePatchTask({ status: "exploded" }, "pending");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("status");
  });

  it("accepts empty patch body (no fields changed)", () => {
    const r = validatePatchTask({}, "pending");
    expect("error" in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCreateSchedule
// ---------------------------------------------------------------------------

describe("validateCreateSchedule", () => {
  it("rejects missing name", () => {
    const r = validateCreateSchedule({ cron_expression: "* * * * *", task_title: "t" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("name");
  });

  it("rejects missing cron_expression", () => {
    const r = validateCreateSchedule({ name: "daily", task_title: "t" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("cron_expression");
  });

  it("rejects invalid cron_expression", () => {
    const r = validateCreateSchedule({ name: "daily", cron_expression: "bad expr", task_title: "t" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("cron_expression");
  });

  it("rejects missing task_title", () => {
    const r = validateCreateSchedule({ name: "daily", cron_expression: "* * * * *" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("task_title");
  });

  it("accepts valid schedule body", () => {
    const r = validateCreateSchedule({
      name: "Weekday 9am",
      cron_expression: "0 9 * * 1-5",
      task_title: "Morning sync",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.name).toBe("Weekday 9am");
      expect(r.cron_expression).toBe("0 9 * * 1-5");
    }
  });
});

// ---------------------------------------------------------------------------
// validatePatchSchedule
// ---------------------------------------------------------------------------

describe("validatePatchSchedule", () => {
  it("accepts empty patch", () => {
    const r = validatePatchSchedule({});
    expect("error" in r).toBe(false);
  });

  it("rejects invalid cron in PATCH", () => {
    const r = validatePatchSchedule({ cron_expression: "not a cron" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("cron_expression");
  });

  it("accepts valid cron PATCH", () => {
    const r = validatePatchSchedule({ cron_expression: "0 0 * * *" });
    expect("error" in r).toBe(false);
  });

  it("rejects empty name string", () => {
    const r = validatePatchSchedule({ name: "" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.field).toBe("name");
  });
});
