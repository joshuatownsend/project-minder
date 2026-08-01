import { describe, it, expect, beforeEach } from "vitest";
import { matchRule, matchRules, clearRegexCache } from "@/lib/notifications/rules/matcher";
import type { FieldValues } from "@/lib/notifications/rules/fields";
import type { NotificationRule } from "@/lib/notifications/rules/types";

function rule(over: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: "r1",
    name: "Test rule",
    enabled: true,
    field: "tool.input",
    op: "contains",
    pattern: ".env",
    channels: { os: true },
    ...over,
  };
}

const FIELDS: FieldValues = {
  event: "PreToolUse",
  project: "app",
  "tool.name": "Read",
  "tool.input": "file_path C:\\dev\\app\\.env.local",
  "tool.durationMs": 91_000,
  "tool.failed": "true",
};

beforeEach(() => clearRegexCache());

describe("matchRule — gating", () => {
  it("does not fire when disabled", () => {
    expect(matchRule(rule({ enabled: false }), FIELDS, "app")).toBeNull();
  });

  it("does not fire for a different project when scoped", () => {
    expect(matchRule(rule({ projectSlug: "other" }), FIELDS, "app")).toBeNull();
    expect(matchRule(rule({ projectSlug: "app" }), FIELDS, "app")).not.toBeNull();
  });

  it("does not fire for an event outside its scope", () => {
    expect(matchRule(rule({ events: ["PostToolUse"] }), FIELDS, "app")).toBeNull();
    expect(matchRule(rule({ events: ["PreToolUse", "PostToolUse"] }), FIELDS, "app")).not.toBeNull();
  });

  it("treats an empty events array as 'all events'", () => {
    expect(matchRule(rule({ events: [] }), FIELDS, "app")).not.toBeNull();
  });

  it("does not fire when the field is absent from this event", () => {
    expect(matchRule(rule({ field: "prompt" }), FIELDS, "app")).toBeNull();
  });
});

describe("matchRule — operators", () => {
  it("contains is case-insensitive", () => {
    expect(matchRule(rule({ pattern: ".ENV" }), FIELDS, "app")).not.toBeNull();
  });

  it("equals requires the whole value", () => {
    expect(matchRule(rule({ field: "tool.name", op: "equals", pattern: "Read" }), FIELDS, "app")).not.toBeNull();
    expect(matchRule(rule({ field: "tool.name", op: "equals", pattern: "Rea" }), FIELDS, "app")).toBeNull();
  });

  it("gt / lt compare numerically, not lexicographically", () => {
    // "91000" < "9" as strings — this would pass with a string comparison.
    expect(matchRule(rule({ field: "tool.durationMs", op: "gt", pattern: "9" }), FIELDS, "app")).not.toBeNull();
    expect(matchRule(rule({ field: "tool.durationMs", op: "lt", pattern: "9" }), FIELDS, "app")).toBeNull();
    expect(matchRule(rule({ field: "tool.durationMs", op: "gt", pattern: "100000" }), FIELDS, "app")).toBeNull();
  });

  it("gt / lt do not fire on a non-numeric threshold or value", () => {
    expect(matchRule(rule({ field: "tool.durationMs", op: "gt", pattern: "soon" }), FIELDS, "app")).toBeNull();
    expect(matchRule(rule({ field: "tool.name", op: "gt", pattern: "5" }), FIELDS, "app")).toBeNull();
  });

  it("matches a boolean field rendered as text", () => {
    expect(matchRule(rule({ field: "tool.failed", op: "equals", pattern: "true" }), FIELDS, "app")).not.toBeNull();
  });

  it("regex is case-insensitive and anchorable", () => {
    expect(matchRule(rule({ op: "regex", pattern: "\\.env(\\.|$)" }), FIELDS, "app")).not.toBeNull();
    expect(matchRule(rule({ op: "regex", pattern: "^nope" }), FIELDS, "app")).toBeNull();
  });

  it("an invalid regex never fires rather than throwing", () => {
    expect(() => matchRule(rule({ op: "regex", pattern: "([" }), FIELDS, "app")).not.toThrow();
    expect(matchRule(rule({ op: "regex", pattern: "([" }), FIELDS, "app")).toBeNull();
  });
});

describe("matchRule — result", () => {
  it("returns a truncated single-line excerpt of the matched value", () => {
    const m = matchRule(rule({ field: "tool.input", pattern: ".env" }), FIELDS, "app");
    expect(m?.excerpt).toBe("file_path C:\\dev\\app\\.env.local");
    expect(m?.projectSlug).toBe("app");
  });

  it("collapses whitespace and ellipsises a long value", () => {
    const m = matchRule(
      rule({ field: "prompt", pattern: "deploy" }),
      { ...FIELDS, prompt: `deploy\n\n   now ${"x".repeat(400)}` },
      "app",
    );
    expect(m?.excerpt).toContain("deploy now");
    expect(m?.excerpt).not.toContain("\n");
    expect(m!.excerpt.endsWith("…")).toBe(true);
  });
});

describe("matchRules", () => {
  it("returns every firing rule in config order", () => {
    const matches = matchRules(
      [
        rule({ id: "a", pattern: "nope" }),
        rule({ id: "b", pattern: ".env" }),
        rule({ id: "c", field: "tool.name", op: "equals", pattern: "Read" }),
      ],
      FIELDS,
      "app",
    );
    expect(matches.map((m) => m.rule.id)).toEqual(["b", "c"]);
  });

  it("returns an empty array for no rules", () => {
    expect(matchRules([], FIELDS, "app")).toEqual([]);
  });
});
