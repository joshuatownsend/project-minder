import { describe, it, expect } from "vitest";
import { demoSessionsList, demoSessionDetail } from "@/lib/demo/sessions";
import { demoUsage, demoClaudeUsage, demoAgentUsage, demoSkillUsage } from "@/lib/demo/usage";
import {
  demoAgents,
  demoSkills,
  filterDemoCatalogRows,
  demoAgentDetail,
  demoSkillDetail,
} from "@/lib/demo/catalogs";
import { demoGithubActivity, demoGitStatus, demoMcpHealth, demoQuota } from "@/lib/demo/activity";

const NOW = 1_700_000_000_000;

/** Every fixture generator, invoked at a fixed nowMs. Wrapped in thunks so we
 *  can call each twice and compare. */
const GENERATORS: Record<string, () => unknown> = {
  sessionsList: () => demoSessionsList(NOW),
  sessionDetail: () => demoSessionDetail("demo-aurora-commerce-1", NOW),
  usagePortfolio: () => demoUsage("today", undefined, NOW),
  usageScoped: () => demoUsage("all", "dev-aurora-commerce", NOW),
  claudeUsage: () => demoClaudeUsage(["C:\\dev\\aurora-commerce"], NOW),
  agentUsage: () => demoAgentUsage("all", NOW),
  skillUsage: () => demoSkillUsage("all", NOW),
  agents: () => demoAgents(NOW),
  skills: () => demoSkills(NOW),
  github: () => demoGithubActivity(NOW),
  gitStatus: () => demoGitStatus(NOW),
  mcpHealth: () => demoMcpHealth(NOW),
  quota: () => demoQuota(NOW),
};

describe("demo fixtures", () => {
  for (const [name, gen] of Object.entries(GENERATORS)) {
    it(`${name} is deterministic for a fixed nowMs`, () => {
      expect(gen()).toEqual(gen());
    });

    it(`${name} produces non-trivial output`, () => {
      // Every generator should return something with real content — a blank
      // fixture would mean a demo surface silently renders empty.
      expect(JSON.stringify(gen()).length).toBeGreaterThan(20);
    });
  }

  it("demoSessionDetail never throws on an unknown id (falls back)", () => {
    expect(() => demoSessionDetail("does-not-exist", NOW)).not.toThrow();
    expect(demoSessionDetail("does-not-exist", NOW)).toBeTruthy();
  });

  it("demoQuota is configured so the burn HUD renders", () => {
    const q = demoQuota(NOW) as { configured?: boolean };
    expect(q.configured).toBe(true);
  });

  it("demoGitStatus keys match the demo projects' dirty counts", () => {
    const s = demoGitStatus(NOW) as Record<string, { uncommittedCount: number }>;
    expect(s["aurora-commerce"].uncommittedCount).toBe(7);
    expect(s["beacon-mobile"].uncommittedCount).toBe(12);
  });

  it("filterDemoCatalogRows normalizes the usage key under the route slug (per-project tabs)", () => {
    // ProjectAgentsTab reads usage.projects[routeSlug], but demo keys dev-<slug>.
    const filtered = filterDemoCatalogRows(demoAgents(NOW), null, "aurora-commerce", null);
    expect(filtered.length).toBeGreaterThan(0);
    for (const r of filtered) {
      // Every surviving row must expose its count under the route slug too.
      expect(r.usage?.projects["aurora-commerce"]).toBeGreaterThan(0);
    }
  });

  it("filterDemoCatalogRows honors the source filter", () => {
    const userOnly = filterDemoCatalogRows(demoAgents(NOW), "user", null, null);
    expect(userOnly.length).toBeGreaterThan(0);
    expect(userOnly.every((r) => r.entry?.source === "user")).toBe(true);
  });

  it("demoAgentDetail / demoSkillDetail resolve a real demo id and 404 (null) otherwise", () => {
    const someAgentId = demoAgents(NOW)[0].entry!.id;
    const a = demoAgentDetail(someAgentId, NOW);
    expect(a).not.toBeNull();
    expect(a!.entry.id).toBe(someAgentId);
    expect(a!.bodyFull.length).toBeGreaterThan(0); // synthetic body, not 404
    expect(demoAgentDetail("agent:user:does-not-exist", NOW)).toBeNull();

    const someSkillId = demoSkills(NOW)[0].entry!.id;
    expect(demoSkillDetail(someSkillId, NOW)!.entry.id).toBe(someSkillId);
    expect(demoSkillDetail("skill:user:nope", NOW)).toBeNull();
  });
});
