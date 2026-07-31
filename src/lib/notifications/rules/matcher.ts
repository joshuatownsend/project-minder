/**
 * Notification rules engine — matching.
 *
 * Pure, total, and *bounded*: this runs inline on the `/api/hooks` request
 * path for every tool call in every live session, so a slow match is a slow
 * Claude Code. Every operator here is linear in the (already capped) field
 * length, with the single exception of `regex`, whose cost is bounded by
 * `isPatternSafe` below.
 */

import type { FieldValues } from "./fields";
import {
  MAX_PATTERN_LENGTH,
  type NotificationRule,
  type RuleMatch,
} from "./types";

/** Longest excerpt carried into a notification body. */
const EXCERPT_LENGTH = 160;

/**
 * Reject regex patterns whose worst-case cost is superlinear.
 *
 * Why this exists at all: a rule's `pattern` is user-authored text evaluated
 * against up to 8 KB of tool output on a hot request path. JavaScript's regex
 * engine backtracks and cannot be interrupted — there is no timeout to fall
 * back on, so an unsafe pattern is an un-killable hang of the hook receiver,
 * which in turn stalls the Claude Code session that POSTed to it. The input
 * cap alone is not enough: `(a+)+$` against 4 000 `a`s does not finish in the
 * lifetime of the process.
 *
 * Called by `matchRule` before every regex compile; returns false to skip the
 * rule (a rule that cannot be evaluated safely simply never fires).
 */
export function isPatternSafe(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;

  // Open groups, innermost last. `risky` means "this group's body contains a
  // quantifier or an alternation" — the property that makes quantifying the
  // group exponential, because the engine can then partition the same input
  // exponentially many ways.
  const groups: { risky: boolean }[] = [];

  // Adjacency tracking for the *polynomial* case (`.*.*`), which the
  // group check above cannot see because no group is involved.
  let prevAtom: string | null = null;
  let prevAtomUnbounded = false;

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    let atomStart = i;
    let atomEnd: number;
    let closed: { risky: boolean } | null = null;

    if (c === "\\") {
      if (i + 1 >= pattern.length) return false; // trailing backslash
      atomEnd = i + 1;
    } else if (c === "[") {
      const end = scanCharClass(pattern, i);
      if (end < 0) return false; // unterminated class
      atomEnd = end;
    } else if (c === "(") {
      groups.push({ risky: false });
      i = skipGroupPrefix(pattern, i) + 1;
      prevAtom = null;
      continue;
    } else if (c === ")") {
      closed = groups.pop() ?? null;
      if (!closed) return false; // unbalanced — never compile it
      atomEnd = i;
      atomStart = i;
    } else if (c === "|") {
      // An alternation makes the enclosing group risky, and breaks adjacency.
      if (groups.length > 0) groups[groups.length - 1].risky = true;
      prevAtom = null;
      i++;
      continue;
    } else if (c === "^" || c === "$") {
      prevAtom = null;
      i++;
      continue;
    } else {
      atomEnd = i; // ordinary literal
    }

    const q = readQuantifier(pattern, atomEnd + 1);

    if (!q) {
      // An unquantified risky group still makes its parent risky, so
      // `((a+))+` is caught at the outer `)`.
      if (closed?.risky && groups.length > 0) groups[groups.length - 1].risky = true;
      prevAtom = pattern.slice(atomStart, atomEnd + 1);
      prevAtomUnbounded = false;
      i = atomEnd + 1;
      continue;
    }

    // The exponential case: a quantifier applied to a group whose body itself
    // quantifies or alternates.
    if (closed?.risky) return false;

    // The polynomial case: two *adjacent* unbounded quantifiers whose atoms
    // can match the same character — `.*.*`, `\w+\w+`, and crucially
    // `\w+\d+$`, where the atoms are textually different but digits are a
    // subset of word characters, so the engine can still split a run of
    // digits between them in quadratically many ways.
    //
    // Overlap is decided by `atomsMayOverlap`, not by string equality: an
    // equality test accepts `\w+\d+$` (~22s on a 4 000-character field —
    // long enough to stall the hook receiver), while the opposite extreme,
    // rejecting every adjacent pair, kills `a*b+`, `\w+\s*` and
    // `[a-z]+[0-9]*`, which are disjoint, safe and ubiquitous.
    const atom = pattern.slice(atomStart, atomEnd + 1);
    if (q.unbounded && prevAtomUnbounded && prevAtom !== null) {
      if (atomsMayOverlap(atom, prevAtom)) return false;
    }

    // Quantifying anything makes the enclosing group risky.
    if (groups.length > 0) groups[groups.length - 1].risky = true;

    prevAtom = atom;
    prevAtomUnbounded = q.unbounded;
    i = q.end + 1;
    if (pattern[i] === "?") i++; // lazy modifier (`*?`, `+?`, `{1,2}?`)
  }

  // Unclosed groups would throw at compile time anyway; reject here so the
  // reason is "unsafe" rather than a swallowed syntax error.
  return groups.length === 0;
}

/**
 * Characters used to decide whether two atoms can match the same input.
 *
 * Exhaustive over printable ASCII rather than a hand-picked sample of
 * equivalence classes, because a sample is unsound in the dangerous
 * direction: a *missed* overlap accepts an unsafe pattern. `[a-f]+[d-z]*`
 * overlaps only on `d`–`f`, so any probe set without one of those letters
 * would wave it through.
 *
 * Cost is irrelevant here — this runs only when a pattern actually contains
 * two adjacent unbounded quantifiers, and the verdict is cached per pattern.
 *
 * Residual limit: overlap that exists *only* outside these characters (two
 * disjoint-looking non-ASCII ranges that in fact intersect) is not detected.
 * Such a pattern is still bounded by the field cap, and no realistic rule
 * looks like that.
 */
const OVERLAP_PROBES: readonly string[] = (() => {
  const chars = ["\t", "\n", "\r", "é", "€"];
  for (let code = 0x20; code <= 0x7e; code++) chars.push(String.fromCharCode(code));
  return chars;
})();

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isWordChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || isDigit(c) || c === "_";
}

function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/** Escape sequences that denote a literal control character. */
const ESCAPE_LITERALS: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", "0": "\0",
};

/**
 * Does `atom` match the single character `ch`? Returns null when this cannot
 * be decided (a group, a zero-width assertion, an unrecognised construct) —
 * callers must treat null as "assume it overlaps".
 *
 * Deliberately hand-rolled rather than `new RegExp("^(?:"+atom+")$")`: that
 * would build a regex out of user input inside the very function whose job is
 * to make user input safe, which is both a fresh injection sink and circular.
 */
function atomMatches(atom: string, ch: string): boolean | null {
  if (atom === ".") return ch !== "\n";
  if (atom.length === 1) return atom === ch;

  if (atom.startsWith("\\") && atom.length === 2) {
    const k = atom[1];
    switch (k) {
      case "w": return isWordChar(ch);
      case "W": return !isWordChar(ch);
      case "d": return isDigit(ch);
      case "D": return !isDigit(ch);
      case "s": return isSpaceChar(ch);
      case "S": return !isSpaceChar(ch);
      case "b": case "B": return null; // zero-width, not a character atom
      default: return (ESCAPE_LITERALS[k] ?? k) === ch;
    }
  }

  if (atom.startsWith("[")) return classMatches(atom, ch);
  return null;
}

/** Membership test for a `[...]` class, including ranges, escapes and `^`. */
function classMatches(atom: string, ch: string): boolean | null {
  let i = 1;
  let negated = false;
  if (atom[i] === "^") {
    negated = true;
    i++;
  }
  const end = atom.length - 1; // index of the closing `]`
  let hit = false;

  while (i < end) {
    let lo: string;
    if (atom[i] === "\\") {
      const k = atom[i + 1];
      if (k === "w" || k === "W" || k === "d" || k === "D" || k === "s" || k === "S") {
        const m = atomMatches(`\\${k}`, ch);
        if (m === null) return null;
        if (m) hit = true;
        i += 2;
        continue;
      }
      lo = ESCAPE_LITERALS[k] ?? k;
      i += 2;
    } else {
      lo = atom[i];
      i += 1;
    }

    // A `-` that is not the last member introduces a range.
    if (atom[i] === "-" && i + 1 < end) {
      i++;
      let hi: string;
      if (atom[i] === "\\") {
        hi = ESCAPE_LITERALS[atom[i + 1]] ?? atom[i + 1];
        i += 2;
      } else {
        hi = atom[i];
        i += 1;
      }
      if (ch >= lo && ch <= hi) hit = true;
    } else if (ch === lo) {
      hit = true;
    }
  }

  return negated ? !hit : hit;
}

/**
 * Can these two atoms match the same character? Conservative: anything it
 * cannot decide is reported as overlapping, so a construct this scanner does
 * not model can never widen the accepted set.
 */
function atomsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // `)` stands for a whole group here; its contents are not available, so the
  // only safe answer is "yes".
  if (a === ")" || b === ")") return true;

  for (const ch of OVERLAP_PROBES) {
    const ma = atomMatches(a, ch);
    const mb = atomMatches(b, ch);
    if (ma === null || mb === null) return true;
    if (ma && mb) return true;
  }
  return false;
}

/** Index of the closing `]`, or -1 if the class never terminates. */
function scanCharClass(pattern: string, open: number): number {
  let j = open + 1;
  if (pattern[j] === "^") j++;
  if (pattern[j] === "]") j++; // a leading `]` is a literal
  while (j < pattern.length && pattern[j] !== "]") {
    if (pattern[j] === "\\") j++;
    j++;
  }
  return j < pattern.length ? j : -1;
}

/**
 * Index of the last character of a group's `(?…` prefix, or `open` when there
 * is none. Without this the `?` in `(?:a)+` reads as a quantifier and marks
 * the group risky, rejecting a non-capturing group that is exactly as safe as
 * the capturing one.
 */
function skipGroupPrefix(pattern: string, open: number): number {
  if (pattern[open + 1] !== "?") return open;
  const after = pattern[open + 2];
  if (after === ":" || after === "=" || after === "!") return open + 2;
  if (after === "<") {
    // `(?<=` / `(?<!` are lookbehinds; `(?<name>` is a named group.
    if (pattern[open + 3] === "=" || pattern[open + 3] === "!") return open + 3;
    const close = pattern.indexOf(">", open + 3);
    return close === -1 ? open + 2 : close;
  }
  return open + 1;
}

/**
 * Read a quantifier at `i`. Returns null when there is none — including for a
 * `{` that is not a valid `{n}` / `{n,}` / `{n,m}`, which JavaScript treats as
 * a literal brace.
 */
function readQuantifier(
  pattern: string,
  i: number,
): { end: number; unbounded: boolean } | null {
  const c = pattern[i];
  if (c === "*" || c === "+") return { end: i, unbounded: true };
  if (c === "?") return { end: i, unbounded: false };
  if (c !== "{") return null;

  const close = pattern.indexOf("}", i);
  if (close === -1) return null;
  const body = pattern.slice(i + 1, close);
  // Linear by construction: one quantifier, no nesting, no alternation.
  if (!/^\d+(,\d*)?$/.test(body)) return null;
  return { end: close, unbounded: body.endsWith(",") };
}

/** Compile cache — rules are stable across events, patterns are re-used. */
const regexCache = new Map<string, RegExp | null>();
const MAX_REGEX_CACHE = 100;

/**
 * The single place a rule pattern becomes a RegExp.
 *
 * Building a regex is linear and cannot backtrack — only *running* one can —
 * so construction is safe even for a catastrophic pattern. `isPatternSafe`
 * therefore guards evaluation (`compile`, below), not this.
 */
function tryConstruct(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null; // invalid syntax
  }
}

function compile(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  // Safety first here: an unsafe pattern is never handed to a caller that
  // will `.test()` it.
  const compiled = isPatternSafe(pattern) ? tryConstruct(pattern) : null;

  if (regexCache.size >= MAX_REGEX_CACHE) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Test-only: drop the compiled-pattern cache. */
export function clearRegexCache(): void {
  regexCache.clear();
}

export type PatternVerdict = "ok" | "unsafe" | "invalid";

/**
 * Classify a pattern for the `/api/config` validator.
 *
 * Exists so the validator never calls `new RegExp` on user input itself: this
 * module is the single place a rule pattern is compiled, and the call there is
 * guarded by `isPatternSafe` in the same function. It also lets an unsafe
 * pattern be *reported* at save time rather than only degrading to a rule that
 * silently never fires — the matcher keeps its own guard for patterns
 * hand-written straight into `.minder.json`.
 */
export function describePattern(pattern: string): PatternVerdict {
  // Syntax before safety, deliberately. The safety scan also rejects malformed
  // input (`([` is an unterminated class), so checking it first would report
  // an ordinary typo as "unsafe" — true, but useless to whoever has to fix it.
  // Constructing first costs nothing: it is the *execution* of a catastrophic
  // pattern that hangs, and this result is discarded.
  if (!tryConstruct(pattern)) return "invalid";
  return isPatternSafe(pattern) ? "ok" : "unsafe";
}

function excerpt(value: string | number): string {
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length <= EXCERPT_LENGTH ? s : `${s.slice(0, EXCERPT_LENGTH)}…`;
}

/**
 * Evaluate one rule against one event's fields.
 *
 * Returns `null` for "did not match" *and* for "could not be evaluated"
 * (disabled, wrong event, unsafe pattern, absent field). The caller cannot and
 * should not distinguish them: both mean no notification.
 */
export function matchRule(
  rule: NotificationRule,
  fields: FieldValues,
  projectSlug: string,
): RuleMatch | null {
  if (!rule.enabled) return null;
  if (rule.projectSlug && rule.projectSlug !== projectSlug) return null;
  if (rule.events?.length && !rule.events.includes(String(fields.event ?? ""))) return null;

  const value = fields[rule.field];
  if (value === undefined) return null;

  let matched = false;

  switch (rule.op) {
    case "contains":
      matched = String(value).toLowerCase().includes(rule.pattern.toLowerCase());
      break;
    case "equals":
      matched = String(value).toLowerCase() === rule.pattern.toLowerCase();
      break;
    case "regex": {
      const re = compile(rule.pattern);
      if (!re) return null;
      matched = re.test(String(value));
      break;
    }
    case "gt":
    case "lt": {
      const threshold = Number(rule.pattern);
      const actual = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(threshold) || !Number.isFinite(actual)) return null;
      matched = rule.op === "gt" ? actual > threshold : actual < threshold;
      break;
    }
  }

  if (!matched) return null;
  return { rule, excerpt: excerpt(value), projectSlug };
}

/**
 * Evaluate every rule against one event. Order is config order, so the
 * Settings list reads top-to-bottom the way it fires.
 */
export function matchRules(
  rules: readonly NotificationRule[],
  fields: FieldValues,
  projectSlug: string,
): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const m = matchRule(rule, fields, projectSlug);
    if (m) matches.push(m);
  }
  return matches;
}
