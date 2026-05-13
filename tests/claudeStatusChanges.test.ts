import { describe, it, expect } from "vitest";
import { diffIncidents } from "@/lib/claudeStatus/changes";
import { emptySnapshot } from "@/lib/claudeStatus/types";
import type { ClaudeStatusSnapshot, StatusIncident } from "@/lib/claudeStatus/types";

function snapshot(incidents: StatusIncident[]): ClaudeStatusSnapshot {
  return {
    ...emptySnapshot(),
    incidents,
    overall: incidents.length > 0 ? "incident" : "operational",
  };
}

function incident(overrides: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: "i1",
    name: "Test incident",
    status: "investigating",
    impact: "minor",
    shortlink: "https://status.claude.com/incidents/i1",
    startedAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    resolvedAt: null,
    affectedComponentIds: [],
    latestUpdateBody: null,
    ...overrides,
  };
}

const fixedNow = new Date("2026-05-13T12:00:00.000Z");

describe("diffIncidents", () => {
  it("returns empty when both snapshots are empty", () => {
    expect(diffIncidents(snapshot([]), snapshot([]), fixedNow)).toEqual([]);
  });

  it("emits a 'new' change when an incident appears", () => {
    const changes = diffIncidents(snapshot([]), snapshot([incident()]), fixedNow);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe("new");
    expect(changes[0].incidentId).toBe("i1");
    expect(changes[0].changedAt).toBe(fixedNow.toISOString());
  });

  it("emits 'status-change' when status flips", () => {
    const prev = snapshot([incident({ status: "investigating" })]);
    const next = snapshot([incident({ status: "monitoring" })]);
    const changes = diffIncidents(prev, next, fixedNow);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe("status-change");
    expect(changes[0].status).toBe("monitoring");
  });

  it("emits 'status-change' when impact escalates", () => {
    const prev = snapshot([incident({ impact: "minor" })]);
    const next = snapshot([incident({ impact: "critical" })]);
    const changes = diffIncidents(prev, next, fixedNow);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe("status-change");
    expect(changes[0].impact).toBe("critical");
  });

  it("emits 'resolved' when an incident disappears from the active list", () => {
    const prev = snapshot([incident({ status: "monitoring" })]);
    const next = snapshot([]);
    const changes = diffIncidents(prev, next, fixedNow);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe("resolved");
    expect(changes[0].status).toBe("resolved");
  });

  it("emits nothing when the same incident is unchanged", () => {
    const prev = snapshot([incident()]);
    const next = snapshot([incident()]);
    expect(diffIncidents(prev, next, fixedNow)).toEqual([]);
  });

  it("treats a null previous snapshot as all-new (cold start)", () => {
    const next = snapshot([incident(), incident({ id: "i2" })]);
    const changes = diffIncidents(null, next, fixedNow);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.transition === "new")).toBe(true);
  });

  it("handles a mix of new + status-change + resolved in one diff", () => {
    const prev = snapshot([
      incident({ id: "a", status: "investigating" }),
      incident({ id: "b", status: "monitoring" }),
    ]);
    const next = snapshot([
      incident({ id: "a", status: "identified" }),         // status-change
      incident({ id: "c", impact: "major" }),               // new
      // b dropped → resolved
    ]);
    const changes = diffIncidents(prev, next, fixedNow);
    expect(changes.map((c) => `${c.incidentId}:${c.transition}`).sort()).toEqual([
      "a:status-change",
      "b:resolved",
      "c:new",
    ]);
  });

  it("stamps changedAt from the injected `now`", () => {
    const myNow = new Date("2030-01-01T00:00:00.000Z");
    const changes = diffIncidents(snapshot([]), snapshot([incident()]), myNow);
    expect(changes[0].changedAt).toBe(myNow.toISOString());
  });
});
