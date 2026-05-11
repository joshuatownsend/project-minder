import { describe, it, expect } from "vitest";
import React from "react";
import { parseMarkdown, inlineToReact } from "@/components/ui/MarkdownRenderer";

// Structural tests for the extracted markdown parser. We assert on the
// shape/count of the React.ReactNode tree rather than serializing — the
// renderer is a thin presentational wrapper over inline styles, so the
// invariants worth pinning are: each block produces one element, fenced
// code blocks survive a round trip, and inline markup splits a paragraph
// into the expected mix of strings/elements.

function nodeTypeOf(node: React.ReactNode): string {
  if (React.isValidElement(node)) {
    const t = (node as React.ReactElement).type;
    return typeof t === "string" ? t : (t as { name?: string }).name ?? "component";
  }
  return typeof node;
}

describe("parseMarkdown — block-level", () => {
  it("renders an H1 as a single h1 element", () => {
    const out = parseMarkdown("# Hello");
    expect(out).toHaveLength(1);
    expect(nodeTypeOf(out[0])).toBe("h1");
  });

  it("renders an H2 as a section divider (div with hr line)", () => {
    const out = parseMarkdown("## Section");
    expect(out).toHaveLength(1);
    // H2 uses a styled div, not the literal h2 tag.
    expect(nodeTypeOf(out[0])).toBe("div");
  });

  it("groups consecutive paragraph lines into a single <p>", () => {
    const out = parseMarkdown("Line one\nLine two\nLine three");
    expect(out).toHaveLength(1);
    expect(nodeTypeOf(out[0])).toBe("p");
  });

  it("breaks paragraphs on blank lines", () => {
    const out = parseMarkdown("Para one.\n\nPara two.");
    expect(out).toHaveLength(2);
    expect(nodeTypeOf(out[0])).toBe("p");
    expect(nodeTypeOf(out[1])).toBe("p");
  });

  it("renders fenced code blocks with their language tag", () => {
    const md = "```ts\nconst x = 1;\n```";
    const out = parseMarkdown(md);
    expect(out).toHaveLength(1);
    // Wrapped in a div containing a language label + <pre>
    expect(nodeTypeOf(out[0])).toBe("div");
  });

  it("treats triple-backtick fences without language as plain code", () => {
    const out = parseMarkdown("```\nplain\n```");
    expect(out).toHaveLength(1);
    expect(nodeTypeOf(out[0])).toBe("div");
  });

  it("collapses an unordered list into a single <ul>", () => {
    const out = parseMarkdown("- one\n- two\n- three");
    expect(out).toHaveLength(1);
    expect(nodeTypeOf(out[0])).toBe("ul");
  });

  it("renders a pipe table with header + rows", () => {
    const out = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(out).toHaveLength(1);
    expect(nodeTypeOf(out[0])).toBe("div"); // table wrapper for overflow
  });

  it("handles a heading-then-paragraph-then-list sequence", () => {
    const out = parseMarkdown("# Title\n\nThis is text.\n\n- item a\n- item b");
    expect(out).toHaveLength(3);
    expect(nodeTypeOf(out[0])).toBe("h1");
    expect(nodeTypeOf(out[1])).toBe("p");
    expect(nodeTypeOf(out[2])).toBe("ul");
  });

  it("ignores empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("inlineToReact — span-level", () => {
  it("returns a plain string when no markup is present", () => {
    const out = inlineToReact("plain text");
    expect(out).toBe("plain text");
  });

  it("wraps **bold** in a <strong>", () => {
    const out = inlineToReact("see **this** word");
    // Array of [string, strong, string]
    expect(Array.isArray(out)).toBe(true);
    const parts = out as React.ReactNode[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("see ");
    expect(nodeTypeOf(parts[1])).toBe("strong");
    expect(parts[2]).toBe(" word");
  });

  it("wraps `code` in a <code>", () => {
    const out = inlineToReact("use `npm run dev`");
    const parts = out as React.ReactNode[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("use ");
    expect(nodeTypeOf(parts[1])).toBe("code");
  });

  it("wraps [label](href) in an <a> with a data-href attribute", () => {
    const out = inlineToReact("[click](memory.md)");
    // Single match returns the bare element (no trailing string)
    expect(React.isValidElement(out)).toBe(true);
    const el = out as React.ReactElement<{ "data-href": string }>;
    expect(nodeTypeOf(el)).toBe("a");
    expect(el.props["data-href"]).toBe("memory.md");
  });

  it("handles multiple inline markers in one line", () => {
    const out = inlineToReact("**bold** and `code` and [link](x.md)");
    const parts = out as React.ReactNode[];
    // bold, " and ", code, " and ", link
    expect(parts).toHaveLength(5);
    expect(nodeTypeOf(parts[0])).toBe("strong");
    expect(parts[1]).toBe(" and ");
    expect(nodeTypeOf(parts[2])).toBe("code");
    expect(parts[3]).toBe(" and ");
    expect(nodeTypeOf(parts[4])).toBe("a");
  });
});
