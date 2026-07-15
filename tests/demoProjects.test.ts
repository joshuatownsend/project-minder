import { describe, it, expect } from "vitest";
import { demoProjects, demoScanResult } from "@/lib/demo/projects";

const NOW = 1_700_000_000_000;

describe("demoProjects", () => {
  it("is deterministic for a fixed nowMs (stable screenshots)", () => {
    expect(demoProjects(NOW)).toEqual(demoProjects(NOW));
  });

  it("anchors timestamps to nowMs so relative times stay fresh", () => {
    const later = NOW + 3 * 24 * 3600_000;
    const a = demoProjects(NOW)[0];
    const b = demoProjects(later)[0];
    // Same structure, shifted clock: scannedAt tracks nowMs exactly.
    expect(a.scannedAt).toBe(new Date(NOW).toISOString());
    expect(b.scannedAt).toBe(new Date(later).toISOString());
    expect(a.slug).toBe(b.slug);
  });

  it("produces a plausible portfolio across all three statuses", () => {
    const ps = demoProjects(NOW);
    expect(ps.length).toBeGreaterThanOrEqual(6);
    const statuses = new Set(ps.map((p) => p.status));
    expect(statuses).toContain("active");
    expect(statuses).toContain("paused");
    expect(statuses).toContain("archived");
  });

  it("every project satisfies the required ProjectData core", () => {
    for (const p of demoProjects(NOW)) {
      expect(p.slug).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.path).toMatch(/^C:\\dev\\/);
      expect(p.usageSlug).toBe(`dev-${p.slug}`); // cross-refs the usage aggregates
      expect(Array.isArray(p.dependencies)).toBe(true);
      expect(Array.isArray(p.dockerPorts)).toBe(true);
      expect(Array.isArray(p.externalServices)).toBe(true);
      expect(p.claudeMdAudit).toBeDefined();
      expect(typeof p.claudeMdAudit.hasClaudeMd).toBe("boolean");
    }
  });

  it("lights up the scan-cache-backed panels (board / insights / manual-steps / ops)", () => {
    const ps = demoProjects(NOW);
    expect(ps.some((p) => (p.board?.total ?? 0) > 0)).toBe(true);
    expect(ps.some((p) => (p.insights?.total ?? 0) > 0)).toBe(true);
    expect(ps.some((p) => (p.manualSteps?.totalSteps ?? 0) > 0)).toBe(true);
    expect(ps.some((p) => (p.operations?.totalItems ?? 0) > 0)).toBe(true);
    expect(ps.some((p) => (p.todos?.total ?? 0) > 0)).toBe(true);
  });

  it("marks every project demo:true so the client can hide session-derived tabs", () => {
    // Hot Files / Errors / Patterns read real ~/.claude JSONL keyed on the fake
    // C:\dev\<slug> path and render empty in demo mode. ProjectDetail keys off
    // this payload-borne marker (robust to both MINDER_DEMO=1 and the flag) to
    // suppress those three tabs. A missing marker would let them render blank.
    for (const p of demoProjects(NOW)) {
      expect(p.demo).toBe(true);
    }
  });

  it("git dirtiness is internally consistent (isDirty ⇔ uncommittedCount>0)", () => {
    for (const p of demoProjects(NOW)) {
      if (p.git) expect(p.git.isDirty).toBe(p.git.uncommittedCount > 0);
    }
  });

  it("orders projects freshest-activity first (matches the real scanner)", () => {
    const ps = demoProjects(NOW);
    for (let i = 1; i < ps.length; i++) {
      expect((ps[i - 1].lastActivity ?? "") >= (ps[i].lastActivity ?? "")).toBe(true);
    }
  });

  it("surfaces a coherent :3000 port conflict (both projects advertise it)", () => {
    const r = demoScanResult(NOW);
    const conflict = r.portConflicts.find((c) => c.port === 3000);
    expect(conflict).toBeDefined();
    const byPort3000 = demoProjects(NOW).filter((p) => p.devPort === 3000).map((p) => p.slug);
    for (const slug of conflict!.projects) expect(byPort3000).toContain(slug);
  });

  it("demoScanResult wraps the projects with a valid ScanResult shape", () => {
    const r = demoScanResult(NOW);
    expect(r.projects.length).toBe(demoProjects(NOW).length);
    expect(Array.isArray(r.portConflicts)).toBe(true);
    expect(Array.isArray(r.catalogLintFindings)).toBe(true);
    expect(r.hiddenCount).toBe(0);
    expect(r.scannedAt).toBe(new Date(NOW).toISOString());
  });
});
