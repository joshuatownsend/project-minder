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

    // The polynomial case: two *adjacent* unbounded quantifiers over
    // overlapping character sets — `.*.*`, `\w+\w+`. Restricted to identical
    // atoms or a `.` (which overlaps everything) on purpose: the naive
    // "two unbounded quantifiers in a row" rule also rejects `a*b+` and
    // `\w+\s*`, which are disjoint, safe, and extremely common. Rejecting
    // those would push this from strict into unusable.
    const atom = pattern.slice(atomStart, atomEnd + 1);
    if (q.unbounded && prevAtomUnbounded && prevAtom !== null) {
      if (atom === prevAtom || atom === "." || prevAtom === ".") return false;
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

function compile(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  if (isPatternSafe(pattern)) {
    try {
      compiled = new RegExp(pattern, "i");
    } catch {
      compiled = null; // invalid syntax — rule never fires
    }
  }

  if (regexCache.size >= MAX_REGEX_CACHE) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Test-only: drop the compiled-pattern cache. */
export function clearRegexCache(): void {
  regexCache.clear();
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
