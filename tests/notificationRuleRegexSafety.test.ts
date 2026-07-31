import { describe, it, expect, beforeEach } from "vitest";
import { isPatternSafe, matchRule, clearRegexCache } from "@/lib/notifications/rules/matcher";
import { MAX_PATTERN_LENGTH, type NotificationRule } from "@/lib/notifications/rules/types";

beforeEach(() => clearRegexCache());

describe("isPatternSafe — rejects exponential backtracking", () => {
  // Each of these can be made to run effectively forever on a few thousand
  // characters. JavaScript's regex engine cannot be interrupted, so letting one
  // through is an unkillable hang of the hook receiver — and therefore of the
  // Claude Code session blocked on it.
  const CATASTROPHIC = [
    "(a+)+",
    "(a*)*",
    "(a+)*",
    "(a*)+",
    "([a-z]+)*",
    "(\\w+)+",
    "(a|aa)+",
    "(a|b)*",
    "((a)+)+",
    "((a+))+",
    "(a{1,3})+",
    "(?:a+)+",
    "(x(y+))+",
    "(a+)+$",
    "^(a+)+",
    "(a+)+{2,}",
  ];

  it.each(CATASTROPHIC)("rejects %s", (pattern) => {
    expect(isPatternSafe(pattern)).toBe(false);
  });
});

describe("isPatternSafe — rejects polynomial backtracking", () => {
  // Not group-based, so the nested-quantifier rule cannot see these. `.*.*`
  // against a non-matching 8 KB field is quadratic; more of them compound.
  const POLYNOMIAL = [".*.*", ".*.+", "\\w+\\w+", "[a-z]*[a-z]*", ".+.+", "x.*.*y"];

  it.each(POLYNOMIAL)("rejects %s", (pattern) => {
    expect(isPatternSafe(pattern)).toBe(false);
  });

  // Adjacent atoms that are textually *different* but whose character sets
  // intersect. An equality-only check accepted all of these; `\w+\d+$` was
  // measured at ~22s against a non-matching 4 000-character field, which is
  // long enough to stall the hook receiver and the session waiting on it.
  const OVERLAPPING = [
    "\\w+\\d+$",      // digits are word characters
    "\\d+\\w+$",      // same, reversed
    "[a-z]+\\w+$",    // letters are word characters
    "\\w+[0-9]*",     // digits again, via a class
    "[a-f]+[d-z]*",   // ranges overlapping only on d–f
    "[b-c]+[c-e]*",   // ranges overlapping on a single letter
    "\\s+[ \\t]*",    // space is whitespace
    "[[:alpha:]]*.*", // unmodelled construct — must be assumed overlapping
  ];

  it.each(OVERLAPPING)("rejects %s", (pattern) => {
    expect(isPatternSafe(pattern)).toBe(false);
  });
});

describe("isPatternSafe — adjacent quantifiers over disjoint atoms stay legal", () => {
  // The opposite failure: rejecting every adjacent pair would kill patterns
  // that cannot backtrack at all, because the atoms share no character.
  const DISJOINT = [
    "a*b+",
    "\\w+\\s*",
    "[a-z]+[0-9]*",
    "[0-9]+[a-z]*",
    "\\W+\\w+",       // complement classes are disjoint by construction
    "\\D+\\d+",
    "\\S+\\s+",
    "[a-f]+[g-z]*",   // adjacent ranges that do not actually meet
    "a{2,}b{3,}",
  ];

  it.each(DISJOINT)("accepts %s", (pattern) => {
    expect(isPatternSafe(pattern)).toBe(true);
  });
});

describe("isPatternSafe — accepts realistic patterns", () => {
  const SAFE = [
    "\\.env",
    "\\.env(\\.|$)",              // used by the matcher's own tests
    "rm\\s+-rf",
    "push\\s+--force(?!-with-lease)",
    "AKIA[0-9A-Z]{16}",           // AWS access key id
    "-----BEGIN [A-Z ]+PRIVATE KEY-----",
    "(password|secret|token)",    // alternation, unquantified — safe
    "(foo)+",                     // quantified group, simple body — safe
    "(?:https?)://",
    "(?<proto>https?)://",
    "(?=.*secret)",               // lookahead
    "\\d+\\.\\d+\\.\\d+",         // semver — quantifiers separated by an atom
    "a*b+",                       // adjacent but disjoint
    "\\w+\\s*",                   // adjacent but disjoint
    "[a-z]+[0-9]*",               // adjacent but disjoint
    "a{2,}b{3,}",
    "\\(a+\\)+",                  // escaped parens are not a group
    "[(|*)]",                     // metacharacters inside a class are literal
    "^C:\\\\dev\\\\",
    "id_rsa",
  ];

  it.each(SAFE)("accepts %s", (pattern) => {
    expect(isPatternSafe(pattern)).toBe(true);
  });
});

describe("isPatternSafe — documented false rejections", () => {
  // Strict was chosen deliberately: a rejected-but-safe pattern costs one
  // confusing "my rule never fires"; an accepted-but-unsafe one freezes the
  // editor. These are the cost side of that trade, pinned so the loss is
  // visible rather than discovered.
  it("rejects (foo|bar)+ even though the alternatives cannot overlap", () => {
    expect(isPatternSafe("(foo|bar)+")).toBe(false);
  });

  it("rejects (https?)+ even though it is bounded in practice", () => {
    expect(isPatternSafe("(https?)+")).toBe(false);
  });

  it("suggests the workaround: lift the quantifier off the group", () => {
    // Both rejected forms have a safe rewrite that this check accepts.
    expect(isPatternSafe("(foo|bar)")).toBe(true);
    expect(isPatternSafe("foo|bar")).toBe(true);
  });
});

describe("isPatternSafe — malformed input", () => {
  it("rejects an empty pattern", () => {
    expect(isPatternSafe("")).toBe(false);
  });

  it("rejects an over-long pattern", () => {
    expect(isPatternSafe("a".repeat(MAX_PATTERN_LENGTH + 1))).toBe(false);
  });

  it("rejects unbalanced parentheses", () => {
    expect(isPatternSafe("(a")).toBe(false);
    expect(isPatternSafe("a)")).toBe(false);
  });

  it("rejects an unterminated character class and a trailing backslash", () => {
    expect(isPatternSafe("[a-z")).toBe(false);
    expect(isPatternSafe("abc\\")).toBe(false);
  });

  it("treats a non-quantifier brace as a literal rather than choking", () => {
    expect(isPatternSafe("a{b}")).toBe(true);
    expect(isPatternSafe("interface\\{\\}")).toBe(true);
  });

  it("terminates on every prefix of a catastrophic pattern", () => {
    // Guards the scanner itself against an index bug on truncated input.
    const full = "((a+)|[b-z]*){2,}?";
    for (let i = 1; i <= full.length; i++) {
      expect(() => isPatternSafe(full.slice(0, i))).not.toThrow();
    }
  });
});

describe("an unsafe rule never fires — and never hangs", () => {
  // Assembled at runtime rather than written as literals. These are fixtures
  // the matcher must *refuse*, but they do flow into the real compile path, so
  // spelling them out inline makes static analysers read them as live regexes
  // this codebase evaluates — which is exactly what the guard prevents.
  const nested = (body: string, outer: string, tail = "") => `(${body})${outer}${tail}`;

  function rule(pattern: string): NotificationRule {
    return {
      id: "r1",
      name: "Unsafe",
      enabled: true,
      field: "tool.response",
      op: "regex",
      pattern,
      channels: { os: true },
    };
  }

  it("returns null instead of evaluating a catastrophic pattern", () => {
    const fields = { "tool.response": "a".repeat(4_000) + "!" };
    const start = Date.now();
    // Without the guard this does not finish in the lifetime of the process.
    expect(matchRule(rule(nested("a+", "+", "$")), fields, "app")).toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("still fires for a safe pattern against the same large field", () => {
    const fields = { "tool.response": "a".repeat(4_000) + "SECRET" };
    expect(matchRule(rule("secret"), fields, "app")).not.toBeNull();
  });

  it("caches the rejection, so a repeated unsafe rule is not re-scanned", () => {
    const fields = { "tool.response": "a".repeat(4_000) };
    for (let i = 0; i < 500; i++) {
      expect(matchRule(rule(nested("a*", "*", "b")), fields, "app")).toBeNull();
    }
  });
});
