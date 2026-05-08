import { describe, it, expect } from "vitest";
import { validateCron, computeNextRun } from "@/lib/tasks/cron";

describe("validateCron", () => {
  it("accepts a standard 5-field weekday expression", () => {
    const result = validateCron("0 9 * * 1-5");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextRun).toBeInstanceOf(Date);
      expect(result.nextRun.getTime()).toBeGreaterThan(Date.now() - 1000);
    }
  });

  it("accepts wildcard every-minute expression", () => {
    const result = validateCron("* * * * *");
    expect(result.ok).toBe(true);
  });

  it("accepts monthly expression", () => {
    const result = validateCron("0 0 1 * *");
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed expression", () => {
    const result = validateCron("bad expression");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("trims whitespace before parsing", () => {
    const result = validateCron("  0 9 * * *  ");
    expect(result.ok).toBe(true);
  });
});

describe("computeNextRun", () => {
  it("returns a future Date for a valid expression", () => {
    const next = computeNextRun("* * * * *");
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("returns null for an invalid expression", () => {
    const next = computeNextRun("not valid");
    expect(next).toBeNull();
  });

  it("respects the `after` parameter", () => {
    // With `after` set to a specific Wednesday morning, the next
    // weekday-9am run should be on that same Wednesday (or Thursday if
    // Wednesday 09:00 has already passed relative to `after`).
    const after = new Date("2026-01-07T08:00:00Z"); // Wednesday 08:00 UTC
    const next = computeNextRun("0 9 * * 1-5", after);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });
});
