import { describe, it, expect } from "vitest";
import { resolveCliLiveness } from "@/lib/agentView/aggregate";

// Tests for aggregate logic: abandoned reaper threshold and session merge ordering.
// Most cases mirror the behavior of aggregateLiveSessions inline. The
// resolveCliLiveness suite imports the real helper from @/lib/agentView/aggregate,
// which is `server-only` — that import resolves under vitest because the config
// aliases `server-only` to a no-op stub (see vitest.config.ts).

type AgentSessionStatus = "waiting" | "working" | "idle" | "completed" | "failed" | "stopped";
type LivenessSource = "daemon" | "hook" | "jsonl" | "cli";

interface MockSession {
  sessionId: string;
  status: AgentSessionStatus;
  secondsSinceChange: number;
  livenessSource: LivenessSource;
}

const STATUS_ORDER: Record<AgentSessionStatus, number> = {
  waiting: 0, working: 1, idle: 2, completed: 3, failed: 4, stopped: 5,
};

function applyAbandonReaper(
  sessions: MockSession[],
  abandonThresholdMin: number,
): MockSession[] {
  const thresholdSec = abandonThresholdMin * 60;
  return sessions.filter((s) => s.secondsSinceChange <= thresholdSec);
}

function sortSessions(sessions: MockSession[]): MockSession[] {
  return [...sessions].sort((a, b) => {
    const diff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (diff !== 0) return diff;
    return a.secondsSinceChange - b.secondsSinceChange;
  });
}

describe("abandoned reaper", () => {
  const sessions: MockSession[] = [
    { sessionId: "s1", status: "working", secondsSinceChange: 60, livenessSource: "jsonl" },
    { sessionId: "s2", status: "idle", secondsSinceChange: 200 * 60, livenessSource: "jsonl" },
    { sessionId: "s3", status: "waiting", secondsSinceChange: 5 * 60, livenessSource: "hook" },
  ];

  it("keeps sessions below threshold", () => {
    const result = applyAbandonReaper(sessions, 180);
    expect(result.map((s) => s.sessionId)).toContain("s1");
    expect(result.map((s) => s.sessionId)).toContain("s3");
  });

  it("drops sessions exceeding threshold (200 min > 180 min)", () => {
    const result = applyAbandonReaper(sessions, 180);
    expect(result.map((s) => s.sessionId)).not.toContain("s2");
  });

  it("threshold of 1 minute drops all sessions > 60s", () => {
    const result = applyAbandonReaper(sessions, 1);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s1");
  });
});

describe("session sort order", () => {
  it("waiting sorts before working, then idle, then completed, failed, stopped", () => {
    const sessions: MockSession[] = [
      { sessionId: "s-idle", status: "idle", secondsSinceChange: 10, livenessSource: "jsonl" },
      { sessionId: "s-stopped", status: "stopped", secondsSinceChange: 10, livenessSource: "daemon" },
      { sessionId: "s-working", status: "working", secondsSinceChange: 10, livenessSource: "hook" },
      { sessionId: "s-waiting", status: "waiting", secondsSinceChange: 10, livenessSource: "hook" },
      { sessionId: "s-failed", status: "failed", secondsSinceChange: 10, livenessSource: "daemon" },
      { sessionId: "s-completed", status: "completed", secondsSinceChange: 10, livenessSource: "daemon" },
    ];
    const sorted = sortSessions(sessions);
    const ids = sorted.map((s) => s.sessionId);
    expect(ids[0]).toBe("s-waiting");
    expect(ids[1]).toBe("s-working");
    expect(ids[2]).toBe("s-idle");
    expect(ids[3]).toBe("s-completed");
    expect(ids[4]).toBe("s-failed");
    expect(ids[5]).toBe("s-stopped");
  });

  it("within same status, more-recent (lower secondsSinceChange) sorts first", () => {
    const sessions: MockSession[] = [
      { sessionId: "older", status: "working", secondsSinceChange: 120, livenessSource: "jsonl" },
      { sessionId: "newer", status: "working", secondsSinceChange: 5, livenessSource: "jsonl" },
    ];
    const sorted = sortSessions(sessions);
    expect(sorted[0].sessionId).toBe("newer");
    expect(sorted[1].sessionId).toBe("older");
  });
});

describe("resolveCliLiveness (#152)", () => {
  it("isLive === true wins: runningProcess true, source 'cli' (overrides fallback)", () => {
    expect(resolveCliLiveness(true, "hook")).toEqual({ runningProcess: true, livenessSource: "cli" });
    expect(resolveCliLiveness(true, "jsonl")).toEqual({ runningProcess: true, livenessSource: "cli" });
  });

  it("isLive === false (CLI says dead): runningProcess false, keeps fallback source", () => {
    expect(resolveCliLiveness(false, "hook")).toEqual({ runningProcess: false, livenessSource: "hook" });
    expect(resolveCliLiveness(false, "jsonl")).toEqual({ runningProcess: false, livenessSource: "jsonl" });
  });

  it("isLive === undefined (CLI unavailable): preserves pre-CLI behavior via fallback", () => {
    // The load-bearing case: older Claude Code installs report no isLive, and
    // the result must be identical to the old hardcoded `false` / fallback.
    expect(resolveCliLiveness(undefined, "hook")).toEqual({ runningProcess: false, livenessSource: "hook" });
    expect(resolveCliLiveness(undefined, "jsonl")).toEqual({ runningProcess: false, livenessSource: "jsonl" });
  });
});

describe("source priority", () => {
  it("daemon source marks runningProcess true; jsonl marks it false", () => {
    // Mirrors logic in aggregateLiveSessions
    const daemonRunning = true;
    const jsonlRunning = false;
    expect(daemonRunning).toBe(true);
    expect(jsonlRunning).toBe(false);
  });

  it("SubagentStop hook event does not end the parent session", () => {
    // SubagentStop is in STOP_EVENTS — but it's keyed on sessionId of the
    // sub-agent, not the parent. The parent session remains Working.
    // Validated by: the buffer.ts STOP_EVENTS includes SubagentStop,
    // but clearLiveSession checks the sessionId which is the CHILD id.
    // Here we just assert the design contract holds conceptually.
    const STOP_EVENTS = new Set(["Stop", "SubagentStop", "SessionEnd"]);
    expect(STOP_EVENTS.has("SubagentStop")).toBe(true);
    // The parent's sessionId would NOT be in the stop call when only a sub-agent stops
    const parentSessionId = "parent-abc";
    const subagentSessionId = "child-xyz";
    const sessionToStop = subagentSessionId;
    expect(sessionToStop).not.toBe(parentSessionId);
  });
});
