import { describe, it, expect } from "vitest";
import { computeAlerts } from "@/lib/agentView/budgetAlerts";
import type { LiveAgentSession } from "@/lib/agentView/types";

function makeSession(overrides: Partial<LiveAgentSession> = {}): LiveAgentSession {
  return {
    sessionId: "sess-1",
    projectSlug: "my-project",
    projectName: "My Project",
    status: "working",
    lastChangedAt: new Date().toISOString(),
    secondsSinceChange: 0,
    runningProcess: true,
    livenessSource: "jsonl",
    costEstimate: 0,
    ...overrides,
  };
}

describe("computeAlerts", () => {
  it("returns no alerts when cost is below 80%", () => {
    const firedMap = new Map<string, Set<number>>();
    const session = makeSession({ costEstimate: 0.3 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    expect(alerts).toHaveLength(0);
  });

  it("fires amber alert when cost reaches 80% of budget", () => {
    const firedMap = new Map<string, Set<number>>();
    const session = makeSession({ costEstimate: 0.8 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].threshold).toBe(0.8);
    expect(alerts[0].sessionId).toBe("sess-1");
  });

  it("fires both amber and red when cost is at or above 100%", () => {
    const firedMap = new Map<string, Set<number>>();
    const session = makeSession({ costEstimate: 1.2 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    expect(alerts.map((a) => a.threshold).sort()).toEqual([0.8, 1.0]);
  });

  it("does not re-fire a threshold already in firedMap", () => {
    const firedMap = new Map<string, Set<number>>();
    firedMap.set("sess-1", new Set([0.8]));
    const session = makeSession({ costEstimate: 0.85 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    // 0.8 already fired; cost hasn't reached 1.0 yet
    expect(alerts).toHaveLength(0);
  });

  it("fires 1.0 alert when 0.8 was already fired and cost crosses 100%", () => {
    const firedMap = new Map<string, Set<number>>();
    firedMap.set("sess-1", new Set([0.8]));
    const session = makeSession({ costEstimate: 1.05 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].threshold).toBe(1.0);
  });

  it("does not re-fire when cost grows from 100% to 120% after both thresholds fired", () => {
    const firedMap = new Map<string, Set<number>>();
    firedMap.set("sess-1", new Set([0.8, 1.0]));
    const session = makeSession({ costEstimate: 1.2 });
    const alerts = computeAlerts([session], 1.0, firedMap);
    expect(alerts).toHaveLength(0);
  });

  it("skips sessions with no costEstimate or zero cost", () => {
    const firedMap = new Map<string, Set<number>>();
    const sessions = [
      makeSession({ sessionId: "a", costEstimate: undefined }),
      makeSession({ sessionId: "b", costEstimate: 0 }),
    ];
    const alerts = computeAlerts(sessions, 1.0, firedMap);
    expect(alerts).toHaveLength(0);
  });

  it("handles multiple sessions independently", () => {
    const firedMap = new Map<string, Set<number>>();
    const sessions = [
      makeSession({ sessionId: "sess-1", costEstimate: 0.85, projectName: "A" }),
      makeSession({ sessionId: "sess-2", costEstimate: 0.5, projectName: "B" }),
      makeSession({ sessionId: "sess-3", costEstimate: 1.1, projectName: "C" }),
    ];
    const alerts = computeAlerts(sessions, 1.0, firedMap);
    // sess-1 crosses 0.8, sess-3 crosses 0.8 and 1.0
    expect(alerts).toHaveLength(3);
    const bySession = new Map(alerts.map((a) => [a.sessionId, a]));
    expect(bySession.get("sess-1")?.threshold).toBe(0.8);
    expect(bySession.get("sess-2")).toBeUndefined();
    // sess-3 should have both, but computeAlerts returns two entries
    const sess3Alerts = alerts.filter((a) => a.sessionId === "sess-3");
    expect(sess3Alerts.map((a) => a.threshold).sort()).toEqual([0.8, 1.0]);
  });

  it("mutates firedMap so subsequent calls don't re-fire", () => {
    const firedMap = new Map<string, Set<number>>();
    const session = makeSession({ costEstimate: 0.9 });

    const first = computeAlerts([session], 1.0, firedMap);
    expect(first).toHaveLength(1);

    const second = computeAlerts([session], 1.0, firedMap);
    expect(second).toHaveLength(0);
  });
});
