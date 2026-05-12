import { describe, it, expect } from "vitest";

// Badge count formula extracted for unit testing — mirrors aggregate.ts logic.
function computeSubagentsInFlight(
  events: Array<{ hookEventName: string; toolName?: string; sessionId: string }>,
  sessionId: string,
): number {
  const sessionEvents = events.filter((e) => e.sessionId === sessionId);
  const spawns = sessionEvents.filter(
    (e) => e.hookEventName === "PreToolUse" && e.toolName === "Agent",
  ).length;
  const stops = sessionEvents.filter(
    (e) => e.hookEventName === "SubagentStop",
  ).length;
  return Math.max(0, spawns - stops);
}

describe("subagentsInFlight badge count", () => {
  it("returns 0 when no events", () => {
    expect(computeSubagentsInFlight([], "sess-1")).toBe(0);
  });

  it("returns spawn count when no stops yet", () => {
    const events = [
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(2);
  });

  it("decrements when SubagentStop arrives", () => {
    const events = [
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
      { hookEventName: "SubagentStop", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(1);
  });

  it("clamps to 0 when stops exceed spawns (buffer eviction edge case)", () => {
    const events = [
      { hookEventName: "SubagentStop", sessionId: "sess-1" },
      { hookEventName: "SubagentStop", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(0);
  });

  it("returns 0 when spawns equal stops (all done)", () => {
    const events = [
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
      { hookEventName: "SubagentStop", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(0);
  });

  it("only counts events for the target sessionId — ignores other sessions", () => {
    const events = [
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-other" },
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-other" },
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(1);
  });

  it("ignores PreToolUse events for non-Agent tools", () => {
    const events = [
      { hookEventName: "PreToolUse", toolName: "Bash", sessionId: "sess-1" },
      { hookEventName: "PreToolUse", toolName: "Read", sessionId: "sess-1" },
      { hookEventName: "PreToolUse", toolName: "Agent", sessionId: "sess-1" },
    ];
    expect(computeSubagentsInFlight(events, "sess-1")).toBe(1);
  });
});
