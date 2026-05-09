import { describe, it, expect } from "vitest";
import { sha256, diffFingerprints } from "@/lib/scanner/mcp-security/fingerprint";
import type { McpToolFingerprint } from "@/lib/types";

describe("sha256", () => {
  it("produces a 64-char hex string", () => {
    const h = sha256("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is stable across calls", () => {
    expect(sha256("test input")).toBe(sha256("test input"));
  });

  it("differs for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("handles empty string", () => {
    expect(sha256("")).toHaveLength(64);
  });
});

function makeFp(serverId: string, toolName: string, hash: string): McpToolFingerprint {
  return { serverId, toolName, descriptionHash: hash, firstSeenMs: 1000, lastSeenMs: 2000 };
}

describe("diffFingerprints", () => {
  it("returns empty diff for identical maps", () => {
    const fp = makeFp("user:foo", "tool1", "abc");
    const prev = new Map([["user:foo:tool1", fp]]);
    const curr = new Map([["user:foo:tool1", fp]]);
    const diff = diffFingerprints(prev, curr);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it("detects added tool", () => {
    const prev = new Map<string, McpToolFingerprint>();
    const curr = new Map([["user:foo:tool1", makeFp("user:foo", "tool1", "abc")]]);
    const diff = diffFingerprints(prev, curr);
    expect(diff.added).toContain("tool1");
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it("detects removed tool", () => {
    const prev = new Map([["user:foo:tool1", makeFp("user:foo", "tool1", "abc")]]);
    const curr = new Map<string, McpToolFingerprint>();
    const diff = diffFingerprints(prev, curr);
    expect(diff.removed).toContain("tool1");
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it("detects changed hash", () => {
    const prev = new Map([["user:foo:tool1", makeFp("user:foo", "tool1", "hash1")]]);
    const curr = new Map([["user:foo:tool1", makeFp("user:foo", "tool1", "hash2")]]);
    const diff = diffFingerprints(prev, curr);
    expect(diff.changed).toContain("tool1");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("handles all three changes at once", () => {
    const prev = new Map([
      ["user:srv:keep",    makeFp("user:srv", "keep",    "h1")],
      ["user:srv:change",  makeFp("user:srv", "change",  "h2")],
      ["user:srv:removed", makeFp("user:srv", "removed", "h3")],
    ]);
    const curr = new Map([
      ["user:srv:keep",   makeFp("user:srv", "keep",   "h1")],
      ["user:srv:change", makeFp("user:srv", "change", "h9")],
      ["user:srv:added",  makeFp("user:srv", "added",  "h4")],
    ]);
    const diff = diffFingerprints(prev, curr);
    expect(diff.added).toContain("added");
    expect(diff.removed).toContain("removed");
    expect(diff.changed).toContain("change");
    expect(diff.added).not.toContain("keep");
    expect(diff.changed).not.toContain("keep");
  });
});
