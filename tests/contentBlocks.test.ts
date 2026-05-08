import { describe, it, expect } from "vitest";
import {
  extractToolResults,
  extractToolResultEntries,
  extractCommandNames,
  isHumanText,
} from "@/lib/usage/contentBlocks";

describe("extractToolResults (legacy)", () => {
  it("joins multiple tool_result text blocks", () => {
    const content = [
      { type: "tool_result", content: "result one" },
      { type: "tool_result", content: "result two" },
    ];
    expect(extractToolResults(content)).toBe("result one\nresult two");
  });

  it("handles nested content array", () => {
    const content = [
      { type: "tool_result", content: [{ type: "text", text: "nested" }] },
    ];
    expect(extractToolResults(content)).toBe("nested");
  });

  it("returns empty string for non-array", () => {
    expect(extractToolResults(null)).toBe("");
    expect(extractToolResults("string")).toBe("");
  });
});

describe("extractToolResultEntries", () => {
  it("preserves is_error=true from tool_result block", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "tu_abc",
        is_error: true,
        content: "permission denied",
      },
    ];
    const entries = extractToolResultEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].isError).toBe(true);
    expect(entries[0].tool_use_id).toBe("tu_abc");
    expect(entries[0].content).toBe("permission denied");
  });

  it("preserves is_error=false (default)", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "tu_ok",
        content: "file contents",
      },
    ];
    const entries = extractToolResultEntries(content);
    expect(entries[0].isError).toBe(false);
  });

  it("handles nested content array in tool_result", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "tu_x",
        is_error: true,
        content: [{ type: "text", text: "ENOENT: no such file" }],
      },
    ];
    const entries = extractToolResultEntries(content);
    expect(entries[0].content).toBe("ENOENT: no such file");
    expect(entries[0].isError).toBe(true);
  });

  it("skips non-tool_result blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "x", name: "Bash", input: {} },
    ];
    expect(extractToolResultEntries(content)).toHaveLength(0);
  });

  it("returns empty array for non-array content", () => {
    expect(extractToolResultEntries(null)).toHaveLength(0);
  });
});

describe("extractCommandNames", () => {
  it("extracts a single slash command name", () => {
    const text = "<command-name>gsd-execute-phase</command-name> do the thing";
    expect(extractCommandNames(text)).toEqual(["gsd-execute-phase"]);
  });

  it("extracts multiple command names from the same string", () => {
    const text = "<command-name>foo</command-name>\n<command-name>bar</command-name>";
    expect(extractCommandNames(text)).toEqual(["foo", "bar"]);
  });

  it("handles content array by joining text blocks", () => {
    const content = [
      { type: "text", text: "<command-name>plan</command-name>" },
      { type: "tool_use", name: "Skill" },
    ];
    expect(extractCommandNames(content)).toEqual(["plan"]);
  });

  it("returns empty array when no command-name tags present", () => {
    expect(extractCommandNames("just normal text")).toEqual([]);
    expect(extractCommandNames(null)).toEqual([]);
  });

  it("trims whitespace from extracted names", () => {
    expect(extractCommandNames("<command-name>  foo  </command-name>")).toEqual(["foo"]);
  });

  it("skips empty command-name tags", () => {
    expect(extractCommandNames("<command-name></command-name>")).toEqual([]);
  });
});

describe("isHumanText interaction", () => {
  it("returns false for command-name bearing text (starts with <)", () => {
    expect(isHumanText("<command-name>plan</command-name>")).toBe(false);
  });

  it("returns true for real human text", () => {
    expect(isHumanText("implement the feature")).toBe(true);
  });
});
