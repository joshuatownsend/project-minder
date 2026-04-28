import { describe, it, expect } from "vitest";
import {
  getJsonPath,
  isConcatDedupePath,
  JsonPathError,
  parsePath,
  RESERVED_SETTINGS_KEYS,
  setJsonPath,
} from "@/lib/template/jsonPath";

describe("parsePath", () => {
  it("splits dotted paths", () => {
    expect(parsePath("permissions.allow")).toEqual(["permissions", "allow"]);
    expect(parsePath("env.MY_VAR")).toEqual(["env", "MY_VAR"]);
  });
  it("treats single-segment paths as one segment", () => {
    expect(parsePath("statusLine")).toEqual(["statusLine"]);
  });
  it("returns empty array for empty string", () => {
    expect(parsePath("")).toEqual([]);
  });
});

describe("getJsonPath", () => {
  const doc = {
    permissions: { allow: ["Bash(git:*)"], ask: [] },
    env: { MY_VAR: "secret" },
    statusLine: "default",
    nullKey: null,
  };

  it("returns top-level scalars", () => {
    expect(getJsonPath(doc, "statusLine")).toEqual({ found: true, value: "default" });
  });
  it("walks nested objects", () => {
    expect(getJsonPath(doc, "permissions.allow")).toEqual({
      found: true,
      value: ["Bash(git:*)"],
    });
  });
  it("returns the document itself for empty path", () => {
    expect(getJsonPath(doc, "")).toEqual({ found: true, value: doc });
  });
  it("returns found:false when key absent", () => {
    expect(getJsonPath(doc, "missing")).toEqual({ found: false });
    expect(getJsonPath(doc, "permissions.deny")).toEqual({ found: false });
  });
  it("returns found:false when intermediate is not an object", () => {
    expect(getJsonPath(doc, "statusLine.nested")).toEqual({ found: false });
    expect(getJsonPath(doc, "permissions.allow.0")).toEqual({ found: false });
  });
  it("distinguishes null value from absent key", () => {
    expect(getJsonPath(doc, "nullKey")).toEqual({ found: true, value: null });
    expect(getJsonPath(doc, "nullKey.deep")).toEqual({ found: false });
  });
});

describe("setJsonPath", () => {
  it("creates intermediate objects when missing", () => {
    const result = setJsonPath({}, "a.b.c", 42);
    expect(result).toEqual({ a: { b: { c: 42 } } });
  });
  it("preserves sibling keys", () => {
    const result = setJsonPath(
      { a: { existing: 1 }, other: "untouched" },
      "a.new",
      2
    );
    expect(result).toEqual({ a: { existing: 1, new: 2 }, other: "untouched" });
  });
  it("does not mutate the original document", () => {
    const orig = { a: { b: 1 } };
    setJsonPath(orig, "a.c", 2);
    expect(orig).toEqual({ a: { b: 1 } });
  });
  it("replaces a value at the leaf path", () => {
    const result = setJsonPath({ a: { b: 1 } }, "a.b", 99);
    expect(result).toEqual({ a: { b: 99 } });
  });
  it("writes to top-level for single-segment paths", () => {
    expect(setJsonPath({}, "statusLine", "minimal")).toEqual({ statusLine: "minimal" });
  });
  it("returns the value verbatim for empty path", () => {
    expect(setJsonPath({ irrelevant: true }, "", 99)).toBe(99);
  });
  it("throws JsonPathError when an intermediate is not an object", () => {
    expect(() => setJsonPath({ a: "scalar" }, "a.b", 1)).toThrow(JsonPathError);
    try {
      setJsonPath({ a: [1, 2] }, "a.b", 1);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JsonPathError);
      expect((e as JsonPathError).code).toBe("PATH_NON_OBJECT_INTERMEDIATE");
    }
  });
});

describe("isConcatDedupePath", () => {
  it("matches the permissions allowlist paths", () => {
    expect(isConcatDedupePath("permissions.allow")).toBe(true);
    expect(isConcatDedupePath("permissions.ask")).toBe(true);
    expect(isConcatDedupePath("permissions.deny")).toBe(true);
  });
  it("rejects other paths", () => {
    expect(isConcatDedupePath("permissions")).toBe(false);
    expect(isConcatDedupePath("env")).toBe(false);
    expect(isConcatDedupePath("custom.array")).toBe(false);
  });
});

describe("RESERVED_SETTINGS_KEYS", () => {
  it("reserves the keys covered by dedicated unit kinds", () => {
    expect(RESERVED_SETTINGS_KEYS.has("hooks")).toBe(true);
    expect(RESERVED_SETTINGS_KEYS.has("mcpServers")).toBe(true);
    expect(RESERVED_SETTINGS_KEYS.has("enabledPlugins")).toBe(true);
  });
  it("does not reserve other common keys", () => {
    expect(RESERVED_SETTINGS_KEYS.has("permissions")).toBe(false);
    expect(RESERVED_SETTINGS_KEYS.has("env")).toBe(false);
  });
});
