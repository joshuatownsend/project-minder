import { describe, it, expect } from "vitest";
import { countSubagentsInFlight } from "@/lib/agentView/aggregate";
import type { HookEvent } from "@/lib/hooks/buffer";

function ev(hookEventName: string, sessionId: string, toolName?: string): HookEvent {
  return { hookEventName: hookEventName as HookEvent["hookEventName"], sessionId, cwd: "", receivedAt: 0, toolName };
}

describe("subagentsInFlight badge count", () => {
  it("returns 0 when no events", () => {
    expect(countSubagentsInFlight([])).toBe(0);
  });

  it("returns spawn count when no stops yet", () => {
    const events = [ev("PreToolUse", "sess-1", "Agent"), ev("PreToolUse", "sess-1", "Agent")];
    expect(countSubagentsInFlight(events)).toBe(2);
  });

  it("decrements when SubagentStop arrives", () => {
    const events = [
      ev("PreToolUse", "sess-1", "Agent"),
      ev("PreToolUse", "sess-1", "Agent"),
      ev("SubagentStop", "sess-1"),
    ];
    expect(countSubagentsInFlight(events)).toBe(1);
  });

  it("clamps to 0 when stops exceed spawns (buffer eviction edge case)", () => {
    const events = [ev("SubagentStop", "sess-1"), ev("SubagentStop", "sess-1")];
    expect(countSubagentsInFlight(events)).toBe(0);
  });

  it("returns 0 when spawns equal stops (all done)", () => {
    const events = [ev("PreToolUse", "sess-1", "Agent"), ev("SubagentStop", "sess-1")];
    expect(countSubagentsInFlight(events)).toBe(0);
  });

  it("only counts events for the target sessionId — ignores other sessions", () => {
    const events = [
      ev("PreToolUse", "sess-other", "Agent"),
      ev("PreToolUse", "sess-other", "Agent"),
      ev("PreToolUse", "sess-1", "Agent"),
    ];
    expect(countSubagentsInFlight(events.filter((e) => e.sessionId === "sess-1"))).toBe(1);
  });

  it("ignores PreToolUse events for non-Agent tools", () => {
    const events = [
      ev("PreToolUse", "sess-1", "Bash"),
      ev("PreToolUse", "sess-1", "Read"),
      ev("PreToolUse", "sess-1", "Agent"),
    ];
    expect(countSubagentsInFlight(events)).toBe(1);
  });
});
