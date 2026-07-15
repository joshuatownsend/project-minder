import { describe, it, expect } from "vitest";
import { demoSessionsList, demoSessionDetail } from "@/lib/demo/sessions";
import { demoUsage, demoClaudeUsage, demoAgentUsage, demoSkillUsage } from "@/lib/demo/usage";
import { demoAgents, demoSkills } from "@/lib/demo/catalogs";
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
});
