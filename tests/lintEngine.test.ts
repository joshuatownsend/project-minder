import { describe, it, expect, vi } from "vitest";

// Prevent the real CLI subprocess from running in unit tests.
vi.mock("@/lib/lint/library", () => ({
  runLibraryCli: vi.fn().mockResolvedValue([]),
}));

import { runLintEngine, runGlobalLint } from "@/lib/lint/engine";
import { dedupeFindings } from "@/lib/lint/dedupe";
import type { ClaudeMdAuditAbsent, ClaudeMdAuditPresent, LintFinding } from "@/lib/types";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";

const ABSENT: ClaudeMdAuditAbsent = {
  hasClaudeMd: false,
  findings: [
    { code: "no-claude-md", severity: "P1", title: "No CLAUDE.md", fix: "Create a CLAUDE.md", penalty: 0 },
  ],
};

const PRESENT: ClaudeMdAuditPresent = {
  hasClaudeMd: true,
  score: 72,
  projectLines: 210,
  importCount: 0,
  fileBytes: 5000,
  rulesLines: 0,
  rulesFileCount: 0,
  findings: [
    { code: "long-index", severity: "P2", title: "Long index", fix: "Split files", penalty: 3 },
    { code: "file-size",  severity: "P1", title: "Large file",  fix: "Trim",        penalty: 10 },
  ],
};

describe("runLintEngine (Wave A — adapter only)", () => {
  it("emits adapter findings for a present audit", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: PRESENT });
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0].engine).toBe("adapter");
  });

  it("emits the no-claude-md finding for an absent audit", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: ABSENT });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].code).toBe("claude-md/no-claude-md");
  });

  it("computes totalCounts correctly", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: PRESENT });
    expect(report.totalCounts).toEqual({ P0: 0, P1: 1, P2: 1 });
  });

  it("populates countsByTarget for claude-md", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: PRESENT });
    expect(report.countsByTarget["claude-md"]).toEqual({ P0: 0, P1: 1, P2: 1 });
  });

  it("returns no engineErrors in the Wave A pass", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: PRESENT });
    expect(report.engineErrors).toHaveLength(0);
  });

  it("returns empty findings for a zero-finding audit", async () => {
    const clean: ClaudeMdAuditPresent = { ...PRESENT, findings: [] };
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: clean });
    expect(report.findings).toHaveLength(0);
    expect(report.totalCounts).toEqual({ P0: 0, P1: 0, P2: 0 });
    expect(report.countsByTarget).toEqual({});
  });

  it("sets hasBlocking true when a P1 finding exists (strict gate)", async () => {
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: PRESENT });
    expect(report.hasBlocking).toBe(true); // PRESENT carries a P1 file-size finding
  });

  it("sets hasBlocking false when only P2 findings exist", async () => {
    const p2Only: ClaudeMdAuditPresent = {
      ...PRESENT,
      findings: [{ code: "long-index", severity: "P2", title: "Long index", fix: "Split", penalty: 3 }],
    };
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: p2Only });
    expect(report.totalCounts).toEqual({ P0: 0, P1: 0, P2: 1 });
    expect(report.hasBlocking).toBe(false);
  });

  it("sets hasBlocking false for a clean audit", async () => {
    const clean: ClaudeMdAuditPresent = { ...PRESENT, findings: [] };
    const report = await runLintEngine({ projectPath: "", claudeMdAudit: clean });
    expect(report.hasBlocking).toBe(false);
  });

  it("surfaces skill findings when skills input is provided", async () => {
    const skill: SkillEntry = {
      kind: "skill",
      id: "skill:project:my-proj:my-skill",
      slug: "my-skill",
      name: "my-skill",
      source: "project",
      filePath: "/dev/proj/.claude/skills/my-skill/SKILL.md",
      bodyExcerpt: "",
      frontmatter: {},
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      layout: "bundled",
      provenance: { kind: "project-local", projectSlug: "my-proj" },
    };
    const report = await runLintEngine({
      projectPath: "",
      claudeMdAudit: { ...PRESENT, findings: [] },
      skills: [skill],
    });
    const skillFindings = report.findings.filter((f) => f.target === "skill");
    expect(skillFindings.length).toBeGreaterThan(0);
    expect(skillFindings[0].code).toBe("skill/missing-description");
  });
});

describe("runGlobalLint", () => {
  it("returns empty when all inputs are empty", () => {
    const findings = runGlobalLint({
      allSkills: [],
      allAgents: [],
      allCommands: [],
      allPlugins: [],
    });
    expect(findings).toHaveLength(0);
  });

  it("lints user-scope skills (structural rules)", () => {
    const skill: SkillEntry = {
      kind: "skill",
      id: "skill:user:user:no-desc",
      slug: "no-desc",
      name: "no-desc",
      source: "user",
      filePath: "/home/.claude/skills/no-desc/SKILL.md",
      bodyExcerpt: "",
      frontmatter: {},
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      layout: "bundled",
      provenance: { kind: "user-local" },
    };
    const findings = runGlobalLint({
      allSkills: [skill],
      allAgents: [],
      allCommands: [],
      allPlugins: [],
    });
    expect(findings.some((f) => f.code === "skill/missing-description")).toBe(true);
  });

  it("does not lint project-scope entries with structural rules (they are per-project)", () => {
    const skill: SkillEntry = {
      kind: "skill",
      id: "skill:project:proj:some-skill",
      slug: "some-skill",
      name: "some-skill",
      source: "project",
      filePath: "/dev/proj/.claude/skills/SKILL.md",
      bodyExcerpt: "",
      frontmatter: {},
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      layout: "bundled",
      provenance: { kind: "project-local", projectSlug: "proj" },
    };
    const findings = runGlobalLint({
      allSkills: [skill],
      allAgents: [],
      allCommands: [],
      allPlugins: [],
    });
    // Structural finding for this project entry should NOT appear (handled by per-project lint).
    // Cross-scope duplicate check only fires if same name in multiple scopes — no duplicate here.
    expect(findings.filter((f) => f.code === "skill/missing-description")).toHaveLength(0);
  });

  it("emits duplicate-name across user + project scopes", () => {
    const base: SkillEntry = {
      kind: "skill",
      id: "skill:user:user:foo",
      slug: "foo",
      name: "foo",
      description: "a description",
      source: "user",
      filePath: "/home/.claude/skills/foo/SKILL.md",
      bodyExcerpt: "",
      frontmatter: {},
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      layout: "bundled",
      provenance: { kind: "user-local" },
    };
    const projectEntry: SkillEntry = {
      ...base,
      id: "skill:project:proj:foo",
      source: "project",
      filePath: "/dev/proj/.claude/skills/foo/SKILL.md",
      provenance: { kind: "project-local", projectSlug: "proj" },
    };
    const findings = runGlobalLint({
      allSkills: [base, projectEntry],
      allAgents: [],
      allCommands: [],
      allPlugins: [],
    });
    expect(findings.some((f) => f.code === "skill/duplicate-name")).toBe(true);
  });

  it("lints user-scope agents with missing description", () => {
    const agent: AgentEntry = {
      kind: "agent",
      id: "agent:user:user:no-desc",
      slug: "no-desc",
      name: "no-desc",
      source: "user",
      filePath: "/home/.claude/agents/no-desc.md",
      bodyExcerpt: "",
      frontmatter: {},
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
      provenance: { kind: "user-local" },
    };
    const findings = runGlobalLint({
      allSkills: [],
      allAgents: [agent],
      allCommands: [],
      allPlugins: [],
    });
    expect(findings.some((f) => f.code === "agent/missing-description")).toBe(true);
  });
});

describe("dedupeFindings", () => {
  const makeFinding = (
    code: string,
    engine: LintFinding["engine"],
    file?: string,
  ): LintFinding => ({
    target: "skill",
    code: `skill/${code}`,
    severity: "P1",
    title: code,
    fix: "fix",
    penalty: 5,
    engine,
    ...(file ? { file } : {}),
  });

  it("keeps a single finding unchanged", () => {
    const f = makeFinding("missing-frontmatter", "vendored");
    expect(dedupeFindings([[f]])).toEqual([f]);
  });

  it("library wins over vendored for the same rule + file", () => {
    const lib = makeFinding("missing-frontmatter", "library", "a.md");
    const vend = makeFinding("missing-frontmatter", "vendored", "a.md");
    const result = dedupeFindings([[vend], [lib]]);
    expect(result).toHaveLength(1);
    expect(result[0].engine).toBe("library");
  });

  it("library wins over adapter for the same rule + file", () => {
    const lib = makeFinding("no-claude-md", "library");
    const adp = makeFinding("no-claude-md", "adapter");
    expect(dedupeFindings([[adp], [lib]])[0].engine).toBe("library");
  });

  it("vendored wins over adapter for the same rule + file", () => {
    const vend = makeFinding("no-claude-md", "vendored");
    const adp = makeFinding("no-claude-md", "adapter");
    expect(dedupeFindings([[adp], [vend]])[0].engine).toBe("vendored");
  });

  it("keeps distinct rules for the same file", () => {
    const a = makeFinding("rule-a", "vendored", "x.md");
    const b = makeFinding("rule-b", "vendored", "x.md");
    expect(dedupeFindings([[a, b]])).toHaveLength(2);
  });

  it("keeps the same rule for distinct files", () => {
    const a = makeFinding("rule-a", "vendored", "x.md");
    const b = makeFinding("rule-a", "vendored", "y.md");
    expect(dedupeFindings([[a, b]])).toHaveLength(2);
  });

  it("treats no-file and file=x as distinct keys", () => {
    const noFile = makeFinding("rule-a", "vendored");
    const withFile = makeFinding("rule-a", "vendored", "x.md");
    expect(dedupeFindings([[noFile, withFile]])).toHaveLength(2);
  });
});
