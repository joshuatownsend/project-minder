import { describe, it, expect } from "vitest";
import { adaptClaudeMdFindings } from "@/lib/lint/adapter/claudeMd";
import type { ClaudeMdAuditAbsent, ClaudeMdAuditPresent } from "@/lib/types";

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
    { code: "long-index", severity: "P2", title: "Long index", fix: "Split into topic files", penalty: 3 },
    { code: "file-size", severity: "P1", title: "Large file", fix: "Trim or split", penalty: 10, file: "CLAUDE.md" },
  ],
};

describe("adaptClaudeMdFindings", () => {
  it("prefixes all codes with claude-md/", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings.map((f) => f.code)).toEqual([
      "claude-md/long-index",
      "claude-md/file-size",
    ]);
  });

  it("sets target to claude-md on every finding", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings.every((f) => f.target === "claude-md")).toBe(true);
  });

  it("sets engine to adapter on every finding", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings.every((f) => f.engine === "adapter")).toBe(true);
  });

  it("preserves severity verbatim", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings[0].severity).toBe("P2");
    expect(findings[1].severity).toBe("P1");
  });

  it("preserves penalty verbatim (not zeroed out)", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings[0].penalty).toBe(3);
    expect(findings[1].penalty).toBe(10);
  });

  it("preserves file field when present", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect(findings[1].file).toBe("CLAUDE.md");
  });

  it("omits file field when not present on the source finding", () => {
    const findings = adaptClaudeMdFindings(PRESENT);
    expect("file" in findings[0]).toBe(false);
  });

  it("emits the no-claude-md finding from an absent audit", () => {
    const findings = adaptClaudeMdFindings(ABSENT);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("claude-md/no-claude-md");
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].penalty).toBe(0);
  });

  it("returns an empty array when there are no findings", () => {
    const clean: ClaudeMdAuditPresent = { ...PRESENT, findings: [] };
    expect(adaptClaudeMdFindings(clean)).toHaveLength(0);
  });
});
