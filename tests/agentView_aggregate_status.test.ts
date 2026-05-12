import { describe, it, expect } from "vitest";
import { liveStatusToAgentStatus, daemonStateToAgentStatus } from "@/lib/agentView/aggregate";
import { STATUS_ORDER } from "@/lib/agentView/types";
import type { AgentSessionStatus } from "@/lib/agentView/types";

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
  it("waiting sorts before working", () => {
    expect(STATUS_ORDER["waiting"]).toBeLessThan(STATUS_ORDER["working"]);
  });

  it("working sorts before idle", () => {
    expect(STATUS_ORDER["working"]).toBeLessThan(STATUS_ORDER["idle"]);
  });

  it("completed sorts after idle", () => {
    expect(STATUS_ORDER["completed"]).toBeGreaterThan(STATUS_ORDER["idle"]);
  });

  it("covers all statuses", () => {
    const statuses: AgentSessionStatus[] = ["waiting", "working", "idle", "completed", "failed", "stopped"];
    for (const s of statuses) {
      expect(typeof STATUS_ORDER[s]).toBe("number");
    }
  });
});
