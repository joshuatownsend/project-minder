import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("os", () => ({
  default: { homedir: () => "C:\\Users\\test" },
  homedir: () => "C:\\Users\\test",
}));

import { promises as fs } from "fs";
import { expandImports } from "@/lib/scanner/expandImports";

const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("expandImports", () => {
  it("returns content unchanged when no @import directives", async () => {
    mockReadFile.mockResolvedValueOnce("# Plain CLAUDE.md\n\nNo imports here." as never);
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    expect(result.content).toBe("# Plain CLAUDE.md\n\nNo imports here.");
    expect(result.imports).toHaveLength(0);
    expect(result.circular).toHaveLength(0);
  });

  it("inlines a single relative @import", async () => {
    mockReadFile
      .mockResolvedValueOnce("# Top\n@import ./rules.md\n\nDone." as never)
      .mockResolvedValueOnce("inner content" as never);
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    expect(result.content).toContain("inner content");
    expect(result.content).not.toContain("@import ./rules.md");
    expect(result.imports.map((i: { spec: string }) => i.spec)).toEqual(["./rules.md"]);
  });

  it("recurses up to depth 5", async () => {
    // L0 imports L1, L1 imports L2, ..., L5 has no further import
    mockReadFile.mockImplementation(async (file) => {
      const m = String(file).match(/L(\d)\.md/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n < 5) return `L${n} body\n@import ./L${n + 1}.md`;
      return `L${n} body (terminal)`;
    });
    const result = await expandImports("C:\\dev\\proj\\L0.md");
    expect(result.content).toContain("L0 body");
    expect(result.content).toContain("L5 body (terminal)");
    expect(result.maxDepthHit).toBe(false);
  });

  it("stops at depth 5 and reports maxDepthHit", async () => {
    // 6 levels deep: L0 -> L1 -> ... -> L6. L5 should be the deepest expanded.
    mockReadFile.mockImplementation(async (file) => {
      const m = String(file).match(/L(\d)\.md/);
      const n = m ? parseInt(m[1], 10) : 0;
      return `L${n} body\n@import ./L${n + 1}.md`;
    });
    const result = await expandImports("C:\\dev\\proj\\L0.md");
    expect(result.maxDepthHit).toBe(true);
    expect(result.content).toContain("L5 body");
    // L6 is past depth-5; its content should not appear inlined
    expect(result.content).not.toContain("L6 body");
  });

  it("detects circular imports without infinite recursion", async () => {
    // a.md imports b.md which imports a.md
    mockReadFile.mockImplementation(async (file) => {
      const f = String(file);
      if (f.endsWith("a.md")) return "A body\n@import ./b.md";
      if (f.endsWith("b.md")) return "B body\n@import ./a.md";
      return "";
    });
    const result = await expandImports("C:\\dev\\proj\\a.md");
    expect(result.content).toContain("A body");
    expect(result.content).toContain("B body");
    expect(result.circular.length).toBeGreaterThan(0);
    // Must not appear twice
    const aMatches = result.content.match(/A body/g) ?? [];
    expect(aMatches.length).toBe(1);
  });

  it("strips HTML block comments before counting", async () => {
    mockReadFile.mockResolvedValueOnce(
      "# Top\n<!-- secret block\nspanning lines -->\nvisible" as never
    );
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    expect(result.content).not.toContain("secret block");
    expect(result.content).toContain("visible");
  });

  it("expands tilde paths in import directives", async () => {
    const captured: string[] = [];
    mockReadFile.mockImplementation(async (file) => {
      captured.push(String(file));
      const f = String(file);
      if (f.endsWith("CLAUDE.md") && captured.length === 1) {
        return "@import ~/rules.md";
      }
      return "user-scope content";
    });
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    expect(result.content).toContain("user-scope content");
    // Second read should target the home-dir-expanded path
    expect(captured[1]).toContain("C:\\Users\\test");
  });

  it("ignores @import that lives inside a fenced code block", async () => {
    mockReadFile.mockResolvedValueOnce(
      "# Top\n```\n@import ./should-not-resolve.md\n```\nafter" as never
    );
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    // Code-fenced imports are documentation, not directives; verify no read fired for the inner spec.
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(result.content).toContain("@import ./should-not-resolve.md");
  });

  it("treats unreadable imports as missing and continues", async () => {
    mockReadFile
      .mockResolvedValueOnce("@import ./missing.md\n\nstill here" as never)
      .mockRejectedValueOnce(new Error("ENOENT"));
    const result = await expandImports("C:\\dev\\proj\\CLAUDE.md");
    expect(result.content).toContain("still here");
    expect(result.imports[0].error).toMatch(/ENOENT|missing/i);
  });
});
