import { describe, it, expect } from "vitest";
import { validateNotificationRules } from "@/lib/notifications/rules/validate";
import { RULE_PRESETS } from "@/lib/notifications/rules/presets";
import { MAX_PATTERN_LENGTH, MAX_RULES } from "@/lib/notifications/rules/types";

const OK = {
  id: "r1",
  name: "Secret access",
  enabled: true,
  field: "tool.input",
  op: "contains",
  pattern: ".env",
  channels: { os: true },
};

function err(input: unknown): string {
  const r = validateNotificationRules(input);
  if (r.ok) throw new Error("expected validation to fail");
  return r.error;
}

describe("validateNotificationRules — happy path", () => {
  it("accepts a minimal rule", () => {
    const r = validateNotificationRules([OK]);
    expect(r.ok).toBe(true);
  });

  it("accepts every shipped preset — presets must satisfy their own validator", () => {
    // Guards against a preset drifting out of the accepted shape, which would
    // make the "Add" button in Settings 400 with no way for the user to fix it.
    const r = validateNotificationRules(RULE_PRESETS.map((p) => p.rule));
    expect(r.ok).toBe(true);
  });

  it("trims the name and drops absent optional fields", () => {
    const r = validateNotificationRules([{ ...OK, name: "  padded  " }]);
    expect(r.ok && r.rules[0].name).toBe("padded");
    expect(r.ok && "severity" in r.rules[0]).toBe(false);
    expect(r.ok && "cooldownSec" in r.rules[0]).toBe(false);
  });

  it("preserves order", () => {
    const r = validateNotificationRules([OK, { ...OK, id: "r2" }, { ...OK, id: "r3" }]);
    expect(r.ok && r.rules.map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("strips unknown top-level keys rather than storing them", () => {
    const r = validateNotificationRules([{ ...OK, injected: "whatever" }]);
    expect(r.ok && "injected" in r.rules[0]).toBe(false);
  });

  it("accepts cooldownSec of 0 (throttling deliberately off)", () => {
    const r = validateNotificationRules([{ ...OK, cooldownSec: 0 }]);
    expect(r.ok && r.rules[0].cooldownSec).toBe(0);
  });
});

describe("validateNotificationRules — rejections", () => {
  it("rejects a non-array", () => {
    expect(err({})).toMatch(/must be an array/);
  });

  it("rejects more than the rule cap", () => {
    const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ ...OK, id: `r${i}` }));
    expect(err(many)).toMatch(/at most/);
  });

  it("rejects a duplicate id — it is the cooldown key", () => {
    expect(err([OK, { ...OK }])).toMatch(/duplicated/);
  });

  it("rejects an id containing the cooldown key separator", () => {
    expect(err([{ ...OK, id: "a b" }])).toMatch(/letters, digits/);
  });

  it("rejects an unknown field or operator", () => {
    expect(err([{ ...OK, field: "tool.secret" }])).toMatch(/field must be one of/);
    expect(err([{ ...OK, op: "matches" }])).toMatch(/op must be one of/);
  });

  it("rejects an over-long pattern", () => {
    expect(err([{ ...OK, pattern: "x".repeat(MAX_PATTERN_LENGTH + 1) }])).toMatch(/≤/);
  });

  it("rejects an empty pattern (which would match everything)", () => {
    expect(err([{ ...OK, pattern: "" }])).toMatch(/non-empty/);
  });

  it("rejects a non-numeric threshold for a numeric operator", () => {
    expect(err([{ ...OK, field: "tool.durationMs", op: "gt", pattern: "soon" }])).toMatch(/must be a number/);
  });

  it("rejects a syntactically invalid regex at the boundary, not at match time", () => {
    expect(err([{ ...OK, op: "regex", pattern: "([" }])).toMatch(/not a valid regular expression/);
  });

  it("rejects an unsafe-but-valid regex with an actionable message", () => {
    // Syntax errors and safety refusals are deliberately distinct outcomes: a
    // refused pattern otherwise saves fine and then silently never fires.
    const message = err([{ ...OK, op: "regex", pattern: "(" + "a+" + ")+" }]);
    expect(message).toMatch(/rejected as unsafe/);
    expect(message).toMatch(/lifting the quantifier off the group/);
  });

  it("rejects an unsafe pattern only for op: regex — a literal is never compiled", () => {
    // The same text under `contains` is a harmless substring search.
    const r = validateNotificationRules([{ ...OK, op: "contains", pattern: "(" + "a+" + ")+" }]);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown channel or a non-boolean channel value", () => {
    expect(err([{ ...OK, channels: { sms: true } }])).toMatch(/unknown channel/);
    expect(err([{ ...OK, channels: { os: "yes" } }])).toMatch(/must be boolean/);
  });

  it("rejects an unknown hook event name", () => {
    expect(err([{ ...OK, events: ["PreToolYolo"] }])).toMatch(/unknown hook event/);
  });

  it("rejects an out-of-range or non-finite cooldown", () => {
    expect(err([{ ...OK, cooldownSec: -1 }])).toMatch(/between 0 and/);
    expect(err([{ ...OK, cooldownSec: 90_000 }])).toMatch(/between 0 and/);
    expect(err([{ ...OK, cooldownSec: Number.NaN }])).toMatch(/finite/);
  });

  it("rejects a missing or blank name", () => {
    expect(err([{ ...OK, name: "   " }])).toMatch(/non-empty/);
    expect(err([{ ...OK, name: 42 }])).toMatch(/non-empty/);
  });

  it("rejects a non-boolean enabled", () => {
    expect(err([{ ...OK, enabled: "yes" }])).toMatch(/enabled must be boolean/);
  });

  it("names the offending index so the UI can point at the right row", () => {
    expect(err([OK, { ...OK, id: "r2", op: "nope" }])).toMatch(/notificationRules\[1\]/);
  });
});
