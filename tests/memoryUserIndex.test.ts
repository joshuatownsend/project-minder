import { describe, it, expect } from "vitest";
import {
  parseMemoryIndex,
  countMemoryIndexLines,
  joinMemoryIndex,
  summarizeMemoryIndex,
} from "@/lib/memory/memoryIndex";

// Pure-function tests for the MEMORY.md index parser. No FS, no mocks. The
// integration with `listMemoryFiles` (which actually reads MEMORY.md from
// disk and stamps `indexed` on each row) is exercised by memoryDiscovery
// tests once auto-index entries are present.

describe("parseMemoryIndex", () => {
  it("returns empty array for empty input", () => {
    expect(parseMemoryIndex("")).toEqual([]);
  });

  it("parses canonical em-dash bullet lines", () => {
    const md = `# Title

## Section
- [Design system](project_design.md) — OKLCH tokens, Geist fonts
- [Feedback](feedback_design.md) — what to avoid
`;
    expect(parseMemoryIndex(md)).toEqual([
      { title: "Design system", target: "project_design.md", hook: "OKLCH tokens, Geist fonts" },
      { title: "Feedback", target: "feedback_design.md", hook: "what to avoid" },
    ]);
  });

  it("also accepts double-hyphen separator", () => {
    const md = "- [Hyphenated](file.md) -- ascii fallback";
    expect(parseMemoryIndex(md)).toEqual([
      { title: "Hyphenated", target: "file.md", hook: "ascii fallback" },
    ]);
  });

  it("skips bullets that lack the link shape", () => {
    const md = `- plain bullet without link
- still no link, no separator
- [Real](good.md) — actually parseable
- [Almost](no-sep.md) but missing dash
`;
    const out = parseMemoryIndex(md);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe("good.md");
  });

  it("ignores headings, prose, and blank lines", () => {
    const md = `# MEMORY

## Section
Some prose explaining things.

- [Only one](kept.md) — yes

More prose.
`;
    expect(parseMemoryIndex(md)).toHaveLength(1);
  });

  it("preserves order of entries as written", () => {
    const md = `- [Z](z.md) — last
- [A](a.md) — first by file
- [M](m.md) — middle`;
    expect(parseMemoryIndex(md).map((e) => e.target)).toEqual([
      "z.md",
      "a.md",
      "m.md",
    ]);
  });
});

describe("countMemoryIndexLines", () => {
  it("returns 0 for empty content", () => {
    expect(countMemoryIndexLines("")).toBe(0);
  });

  it("counts newline-separated lines", () => {
    expect(countMemoryIndexLines("a\nb\nc")).toBe(3);
  });

  it("ignores trailing newlines", () => {
    expect(countMemoryIndexLines("a\nb\n\n\n")).toBe(2);
  });

  it("handles CRLF line endings", () => {
    expect(countMemoryIndexLines("a\r\nb\r\nc\r\n")).toBe(3);
  });
});

describe("joinMemoryIndex", () => {
  const entries = [
    { title: "A", target: "feature_a.md", hook: "x" },
    { title: "B", target: "feature_b.md", hook: "y" },
    { title: "External", target: "https://example.com/notes", hook: "skipped" },
    { title: "Anchor", target: "#section", hook: "skipped" },
    { title: "Absolute", target: "/etc/passwd", hook: "skipped" },
  ];

  it("flags body files not referenced as orphans", () => {
    const r = joinMemoryIndex(entries, ["feature_a.md", "feature_b.md", "stray.md"]);
    expect(r.orphans).toEqual(["stray.md"]);
    expect(r.dangling).toEqual([]);
  });

  it("flags index entries with no matching file as dangling", () => {
    const r = joinMemoryIndex(entries, ["feature_a.md"]);
    expect(r.dangling).toEqual(["feature_b.md"]);
    expect(r.orphans).toEqual([]);
  });

  it("ignores URL/anchor/absolute targets in orphan + dangling math", () => {
    const r = joinMemoryIndex(entries, ["feature_a.md", "feature_b.md"]);
    expect(r.dangling).toEqual([]);
    expect(r.orphans).toEqual([]);
    expect(r.linkedNames.has("feature_a.md")).toBe(true);
    expect(r.linkedNames.has("https://example.com/notes")).toBe(false);
  });

  it("never flags MEMORY.md itself as orphan", () => {
    const r = joinMemoryIndex([], ["MEMORY.md", "other.md"]);
    expect(r.orphans).toEqual(["other.md"]);
  });

  it("case-insensitive on Windows-style basenames", () => {
    const r = joinMemoryIndex(
      [{ title: "X", target: "Feature_A.md", hook: "h" }],
      ["feature_a.md"],
    );
    expect(r.orphans).toEqual([]);
    expect(r.dangling).toEqual([]);
  });

  it("strips ./ prefix so explicit current-dir links match plain basenames", () => {
    const r = joinMemoryIndex(
      [{ title: "Foo", target: "./foo.md", hook: "h" }],
      ["foo.md"],
    );
    expect(r.dangling).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it("also strips .\\ on Windows-style markdown", () => {
    const r = joinMemoryIndex(
      [{ title: "Foo", target: ".\\foo.md", hook: "h" }],
      ["foo.md"],
    );
    expect(r.dangling).toEqual([]);
    expect(r.orphans).toEqual([]);
  });
});

describe("summarizeMemoryIndex", () => {
  it("returns present=false when index content is null", () => {
    const s = summarizeMemoryIndex({
      projectSlug: "p",
      projectName: "P",
      indexContent: null,
      bodyFilenames: ["a.md", "b.md", "MEMORY.md"],
    });
    expect(s.present).toBe(false);
    expect(s.lineCount).toBe(0);
    expect(s.entryCount).toBe(0);
    expect(s.orphans).toEqual(["a.md", "b.md"]);
    expect(s.dangling).toEqual([]);
  });

  it("composes parse + join + line count for present index", () => {
    const indexContent = `# Memory

- [Alpha](alpha.md) — first
- [Beta](beta.md) — second
- [Gone](missing.md) — dangling
`;
    const s = summarizeMemoryIndex({
      projectSlug: "p",
      projectName: "P",
      indexContent,
      bodyFilenames: ["alpha.md", "beta.md", "orphaned.md"],
    });
    expect(s.present).toBe(true);
    expect(s.entryCount).toBe(3);
    expect(s.lineCount).toBe(5);
    expect(s.orphans).toEqual(["orphaned.md"]);
    expect(s.dangling).toEqual(["missing.md"]);
    expect(s.linkedNames.sort()).toEqual(["alpha.md", "beta.md", "missing.md"]);
  });
});
