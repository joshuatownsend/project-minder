import { describe, it, expect, vi } from "vitest";

// Prevent the real CLI subprocess from running in unit tests.
vi.mock("@/lib/lint/library", () => ({
  runLibraryCli: vi.fn().mockResolvedValue([]),
}));

import { runLintEngine } from "@/lib/lint/engine";
import { dedupeFindings } from "@/lib/lint/dedupe";
import type { ClaudeMdAuditAbsent, ClaudeMdAuditPresent, LintFinding } from "@/lib/types";

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
