import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\test" },
  homedir: () => "C:\\Users\\test",
}));

import { promises as fs } from "fs";
import { auditClaudeMd } from "@/lib/scanner/claudeMdAudit";

const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir) as unknown as ReturnType<typeof vi.fn>;
const mockStat = vi.mocked(fs.stat);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: user-scope CLAUDE.md doesn't exist (so the test focuses on the project file).
  mockStat.mockRejectedValue(new Error("ENOENT") as never);
  // Default: empty rules tree, no sibling .md files.
  mockReaddir.mockResolvedValue([]);
});

describe("auditClaudeMd", () => {
  it("returns hasClaudeMd:false with a P1 'no claude.md' finding when missing", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await auditClaudeMd("C:\\dev\\proj-empty");
    expect(result.hasClaudeMd).toBe(false);
    expect(result.score).toBe(0);
    expect(result.findings[0].code).toBe("no-claude-md");
  });

  it("scores 100 for a tiny single-section CLAUDE.md", async () => {
    mockReadFile.mockResolvedValueOnce("# Project\n\nA short index." as never);
    const result = await auditClaudeMd("C:\\dev\\proj-tiny");
    expect(result.hasClaudeMd).toBe(true);
    expect(result.score).toBe(100);
    expect(result.findings).toHaveLength(0);
  });

  it("penalises visibility cap when CLAUDE.md exceeds 200 lines", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    mockReadFile.mockResolvedValueOnce(big as never);
    // hasSiblingMd uses plain readdir (returns string[]); pretend a sibling exists
    // so the visibility test isn't compounded by missing-topic-files.
    mockReaddir.mockResolvedValueOnce(["ARCHITECTURE.md"] as never);
    const result = await auditClaudeMd("C:\\dev\\proj-big");
    const visibility = result.findings.find((f) => f.code === "visibility-cap");
    expect(visibility).toBeDefined();
    expect(visibility?.severity).toBe("P0");
    // 200/400 = 50% visible → penalty = (100-50)*0.5 = 25
    expect(visibility?.penalty).toBe(25);
    expect(result.score).toBe(75);
  });

  it("penalises file size when CLAUDE.md > 25 KB", async () => {
    // 26 KB of repeating content, kept under 200 lines so visibility doesn't fire.
    const huge = "x".repeat(26 * 1024);
    mockReadFile.mockResolvedValueOnce(`# Big\n${huge}` as never);
    const result = await auditClaudeMd("C:\\dev\\proj-fat");
    const size = result.findings.find((f) => f.code === "file-size");
    expect(size).toBeDefined();
    expect(size?.penalty).toBe(10);
  });

  it("flags inline bloat when sections exceed 5 content lines", async () => {
    const bloated = [
      "# Section A",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "# Section B",
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
    ].join("\n");
    mockReadFile.mockResolvedValueOnce(bloated as never);
    const result = await auditClaudeMd("C:\\dev\\proj-bloat");
    const bloat = result.findings.find((f) => f.code === "inline-bloat");
    expect(bloat).toBeDefined();
    expect(bloat?.penalty).toBeGreaterThanOrEqual(3);
  });

  it("flags missing topic files when index >50 lines and no @imports/siblings", async () => {
    const fifty = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    mockReadFile.mockResolvedValueOnce(fifty as never);
    // readdir returns empty → no sibling .md
    const result = await auditClaudeMd("C:\\dev\\proj-flat");
    const missing = result.findings.find((f) => f.code === "missing-topic-files");
    expect(missing).toBeDefined();
    expect(missing?.penalty).toBe(10);
  });

  it("does not flag missing topic files when @imports are present", async () => {
    const withImports = [
      "# Index",
      "@import ./.claude/rules/api.md",
      ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
    ].join("\n");
    mockReadFile
      .mockResolvedValueOnce(withImports as never)
      .mockResolvedValueOnce("api detail" as never);
    const result = await auditClaudeMd("C:\\dev\\proj-imports");
    const missing = result.findings.find((f) => f.code === "missing-topic-files");
    expect(missing).toBeUndefined();
    expect(result.importCount).toBe(1);
  });

  it("flags rules volume when total .claude/rules/* lines exceed 2000", async () => {
    const bigRule = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    // Match by path so call ordering doesn't matter.
    mockReadFile.mockImplementation(async (p: unknown) => {
      const f = String(p);
      if (f.endsWith("CLAUDE.md")) return "# Index\n\nshort";
      if (f.endsWith("big.md")) return bigRule;
      throw new Error(`unexpected readFile: ${f}`);
    });
    mockReaddir.mockImplementation(async (p: unknown) => {
      const d = String(p);
      if (d.endsWith("rules")) {
        return [{ name: "big.md", isDirectory: () => false }] as never;
      }
      return [] as never;
    });
    const result = await auditClaudeMd("C:\\dev\\proj-rules");
    const vol = result.findings.find((f) => f.code === "rules-volume");
    expect(vol).toBeDefined();
    expect(result.rulesLines).toBeGreaterThan(2000);
  });

  it("flags reference-tiering when rules files match on-demand patterns", async () => {
    const referenceDoc = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    mockReadFile.mockImplementation(async (p: unknown) => {
      const f = String(p);
      if (f.endsWith("CLAUDE.md")) return "# Index\n\nshort";
      if (f.endsWith("api-reference.md")) return referenceDoc;
      throw new Error(`unexpected readFile: ${f}`);
    });
    mockReaddir.mockImplementation(async (p: unknown) => {
      const d = String(p);
      if (d.endsWith("rules")) {
        return [{ name: "api-reference.md", isDirectory: () => false }] as never;
      }
      return [] as never;
    });
    const result = await auditClaudeMd("C:\\dev\\proj-tier");
    const tier = result.findings.find((f) => f.code === "reference-tiering");
    expect(tier).toBeDefined();
    expect(tier?.severity).toBe("P2");
  });

  it("clamps score between 0 and 100", async () => {
    // Construct a maximally-bad CLAUDE.md: 1000 lines, >25KB, with lots of bloated sections.
    const lines = Array.from({ length: 1000 }, (_, i) =>
      i % 9 === 0 ? `# Section ${i / 9}` : `bullet ${i}`
    );
    mockReadFile.mockResolvedValueOnce(lines.join("\n") as never);
    const result = await auditClaudeMd("C:\\dev\\proj-disaster");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("severity-sorts findings P0 → P1 → P2", async () => {
    // Trigger P0 (visibility) + P1 (file-size) + P2 (missing topic files).
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const huge = `${big}\n${"x".repeat(26 * 1024)}`;
    mockReadFile.mockResolvedValueOnce(huge as never);
    const result = await auditClaudeMd("C:\\dev\\proj-mixed");
    const severities = result.findings.map((f) => f.severity);
    const indexP0 = severities.indexOf("P0");
    const indexP1 = severities.indexOf("P1");
    expect(indexP0).toBeGreaterThanOrEqual(0);
    expect(indexP0).toBeLessThan(indexP1);
  });
});
