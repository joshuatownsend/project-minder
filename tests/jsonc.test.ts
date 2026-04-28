import { describe, it, expect } from "vitest";
import { stripJsonComments, tryParseJsonc } from "@/lib/scanner/util/jsonc";

describe("stripJsonComments", () => {
  it("removes // line comments", () => {
    const result = stripJsonComments(`{
      // comment
      "a": 1
    }`);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("removes /* block */ comments", () => {
    const result = stripJsonComments(`{ /* explanation */ "a": 1 }`);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("removes structural trailing commas before } and ]", () => {
    expect(JSON.parse(stripJsonComments(`{ "a": 1, }`))).toEqual({ a: 1 });
    expect(JSON.parse(stripJsonComments(`[1, 2, 3,]`))).toEqual([1, 2, 3]);
  });

  it("preserves commas inside string literals", () => {
    // Comma followed by `}` inside a quoted value must NOT be stripped.
    const raw = `{ "command": ",}" }`;
    const result = stripJsonComments(raw);
    expect(JSON.parse(result)).toEqual({ command: ",}" });
  });

  it("preserves `//` and `/*` inside string literals", () => {
    const raw = `{ "url": "http://example.com/api", "comment": "/* not a real comment */" }`;
    expect(JSON.parse(stripJsonComments(raw))).toEqual({
      url: "http://example.com/api",
      comment: "/* not a real comment */",
    });
  });

  it("handles escaped quotes in strings without breaking state", () => {
    const raw = `{ "msg": "she said \\"hi,\\"", "n": 1, }`;
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ msg: 'she said "hi,"', n: 1 });
  });
});

describe("tryParseJsonc", () => {
  it("parses strict JSON without invoking the comment-stripper", () => {
    expect(tryParseJsonc(`{"a":1}`)).toEqual({ a: 1 });
  });

  it("falls back to JSONC parsing only when strict parse fails", () => {
    expect(tryParseJsonc(`{ /* x */ "a": 1, }`)).toEqual({ a: 1 });
  });

  it("returns null when both passes fail", () => {
    expect(tryParseJsonc(`{ "a":`)).toBeNull();
  });
});
