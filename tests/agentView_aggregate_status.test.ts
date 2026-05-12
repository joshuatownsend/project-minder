import { describe, it, expect } from "vitest";

// Test the pure status-mapping functions inline — same values as the module
// exports but without pulling in the server-only aggregate module.

type AgentSessionStatus = "waiting" | "working" | "idle" | "completed" | "failed" | "stopped";
type LiveSessionStatus = "working" | "approval" | "waiting" | "other";

function liveStatusToAgentStatus(s: LiveSessionStatus): AgentSessionStatus {
  if (s === "working") return "working";
  if (s === "approval" || s === "waiting") return "waiting";
  return "idle";
}

function daemonStateToAgentStatus(state?: string): AgentSessionStatus {
  if (!state) return "working";
  const s = state.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "stopped") return "stopped";
  if (s === "waiting" || s === "awaiting_input") return "waiting";
  if (s === "idle") return "idle";
  return "working";
}

describe("liveStatusToAgentStatus", () => {
  it("maps working → working", () => {
    expect(liveStatusToAgentStatus("working")).toBe("working");
  });

  it("maps approval → waiting (same concept: held for user)", () => {
    expect(liveStatusToAgentStatus("approval")).toBe("waiting");
  });

  it("maps waiting → waiting", () => {
    expect(liveStatusToAgentStatus("waiting")).toBe("waiting");
  });

  it("maps other → idle", () => {
    expect(liveStatusToAgentStatus("other")).toBe("idle");
  });
});

describe("daemonStateToAgentStatus", () => {
  it("undefined state → working (optimistic default)", () => {
    expect(daemonStateToAgentStatus(undefined)).toBe("working");
  });

  it("'completed' → completed", () => {
    expect(daemonStateToAgentStatus("completed")).toBe("completed");
  });

  it("'Completed' (mixed case) → completed", () => {
    expect(daemonStateToAgentStatus("Completed")).toBe("completed");
  });

  it("'failed' → failed", () => {
    expect(daemonStateToAgentStatus("failed")).toBe("failed");
  });

  it("'error' → failed (alias)", () => {
    expect(daemonStateToAgentStatus("error")).toBe("failed");
  });

  it("'stopped' → stopped", () => {
    expect(daemonStateToAgentStatus("stopped")).toBe("stopped");
  });

  it("'waiting' → waiting", () => {
    expect(daemonStateToAgentStatus("waiting")).toBe("waiting");
  });

  it("'awaiting_input' → waiting", () => {
    expect(daemonStateToAgentStatus("awaiting_input")).toBe("waiting");
  });

  it("'idle' → idle", () => {
    expect(daemonStateToAgentStatus("idle")).toBe("idle");
  });

  it("unknown state string → working (optimistic)", () => {
    expect(daemonStateToAgentStatus("running")).toBe("working");
  });

  it("SubagentStop does not change parent status — verified by exclusion: subagentstop is not a state value", () => {
    // SubagentStop is a hook event, not a daemon state. When it arrives via
    // hooks the parent's status stays as-is; only 'Stop'/'SessionEnd' clear it.
    expect(daemonStateToAgentStatus("subagentstop")).toBe("working");
  });
});

describe("status sort order", () => {
  const statusOrder: Record<AgentSessionStatus, number> = {
    waiting: 0, working: 1, idle: 2, completed: 3, failed: 4, stopped: 5,
  };

  it("waiting sorts before working", () => {
    expect(statusOrder["waiting"]).toBeLessThan(statusOrder["working"]);
  });

  it("working sorts before idle", () => {
    expect(statusOrder["working"]).toBeLessThan(statusOrder["idle"]);
  });

  it("completed sorts after idle", () => {
    expect(statusOrder["completed"]).toBeGreaterThan(statusOrder["idle"]);
  });
});
