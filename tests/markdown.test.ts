import { describe, it, expect } from "vitest";
import { parseMarkdown, hasCodeFence } from "@/lib/markdown";

describe("parseMarkdown", () => {
  it("returns a single text segment for plain text", () => {
    const result = parseMarkdown("Hello world");
    expect(result).toEqual([{ kind: "text", content: "Hello world" }]);
  });

  it("detects a fenced code block", () => {
    const input = "Here is some code:\n```ts\nconsole.log('hi');\n```\nDone.";
    const result = parseMarkdown(input);
    expect(result.some((s) => s.kind === "code_block")).toBe(true);
    const block = result.find((s) => s.kind === "code_block");
    expect(block?.kind === "code_block" && block.lang).toBe("ts");
    expect(block?.content).toContain("console.log");
  });

  it("detects an inline code span", () => {
    const result = parseMarkdown("Run `npm install` to install.");
    const inline = result.find((s) => s.kind === "code_inline");
    expect(inline?.kind === "code_inline" && inline.content).toBe("npm install");
  });

  it("handles a code block with no language hint", () => {
    const input = "```\nraw code\n```";
    const result = parseMarkdown(input);
    const block = result.find((s) => s.kind === "code_block");
    expect(block?.kind === "code_block" && block.lang).toBe("");
    expect(block?.content).toContain("raw code");
  });

  it("returns empty array for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("handles multiple code blocks", () => {
    const input = "```\nfirst\n```\nbetween\n```\nsecond\n```";
    const result = parseMarkdown(input);
    const blocks = result.filter((s) => s.kind === "code_block");
    expect(blocks.length).toBe(2);
  });

  it("handles inline code within text outside a fence", () => {
    const result = parseMarkdown("Use `a` and `b` together.");
    const inlines = result.filter((s) => s.kind === "code_inline");
    expect(inlines.length).toBe(2);
  });
});

describe("hasCodeFence", () => {
  it("returns true when string contains triple backticks", () => {
    expect(hasCodeFence("```js\nfoo\n```")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasCodeFence("just some text")).toBe(false);
  });
});
