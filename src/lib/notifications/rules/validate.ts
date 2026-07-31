/**
 * Notification rules engine — validation at the `/api/config` boundary.
 *
 * Pure and exhaustive so it can be unit-tested without a request. Rules are
 * the first config surface where the user authors something *executable* (a
 * regex evaluated on a hot path), so this is a real trust boundary, not
 * shape-checking for its own sake: everything the matcher assumes — bounded
 * pattern length, known field, known operator, numeric threshold for numeric
 * operators — is established here.
 *
 * Note the matcher re-checks the limits it depends on rather than trusting
 * this. `.minder.json` is a user-editable file, so a rule can reach the engine
 * without ever passing through the API.
 */

import { describePattern } from "./matcher";
import {
  MAX_COOLDOWN_SEC,
  MAX_PATTERN_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MAX_RULES,
  RULE_CHANNELS,
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_SEVERITIES,
  type NotificationRule,
  type RuleChannel,
  type RuleField,
  type RuleOperator,
  type RuleSeverity,
} from "./types";

const VALID_EVENT_NAMES = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ValidateResult =
  | { ok: true; rules: NotificationRule[] }
  | { ok: false; error: string };

function fail(error: string): ValidateResult {
  return { ok: false, error };
}

export function validateNotificationRules(input: unknown): ValidateResult {
  if (!Array.isArray(input)) return fail("notificationRules must be an array");
  if (input.length > MAX_RULES) {
    return fail(`notificationRules may contain at most ${MAX_RULES} rules`);
  }

  const rules: NotificationRule[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const at = `notificationRules[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail(`${at} must be an object`);
    }
    const r = raw as Record<string, unknown>;

    // id — also the cooldown key and the React key, so it must be unique and
    // free of characters that would make it ambiguous in a composite key.
    if (typeof r.id !== "string" || !r.id || r.id.length > MAX_ID_LENGTH) {
      return fail(`${at}.id must be a non-empty string ≤ ${MAX_ID_LENGTH} chars`);
    }
    if (!ID_PATTERN.test(r.id)) {
      return fail(`${at}.id may only contain letters, digits, hyphens and underscores`);
    }
    if (seenIds.has(r.id)) return fail(`${at}.id "${r.id}" is duplicated`);
    seenIds.add(r.id);

    if (typeof r.name !== "string" || !r.name.trim() || r.name.length > MAX_RULE_NAME_LENGTH) {
      return fail(`${at}.name must be a non-empty string ≤ ${MAX_RULE_NAME_LENGTH} chars`);
    }
    if (typeof r.enabled !== "boolean") return fail(`${at}.enabled must be boolean`);

    if (!(RULE_FIELDS as readonly string[]).includes(r.field as string)) {
      return fail(`${at}.field must be one of: ${RULE_FIELDS.join(", ")}`);
    }
    if (!(RULE_OPERATORS as readonly string[]).includes(r.op as string)) {
      return fail(`${at}.op must be one of: ${RULE_OPERATORS.join(", ")}`);
    }

    const op = r.op as RuleOperator;
    if (typeof r.pattern !== "string" || !r.pattern) {
      return fail(`${at}.pattern must be a non-empty string`);
    }
    if (r.pattern.length > MAX_PATTERN_LENGTH) {
      return fail(`${at}.pattern must be ≤ ${MAX_PATTERN_LENGTH} chars`);
    }
    if ((op === "gt" || op === "lt") && !Number.isFinite(Number(r.pattern))) {
      return fail(`${at}.pattern must be a number when op is "${op}"`);
    }
    if (op === "regex") {
      // Delegated rather than compiled here: `matcher.ts` is the one place a
      // rule pattern is turned into a RegExp, and there the call is guarded by
      // the safety scan. Reporting "unsafe" as a validation error also means
      // the user is told, instead of saving a rule that can never fire.
      const verdict = describePattern(r.pattern);
      if (verdict === "invalid") {
        return fail(`${at}.pattern is not a valid regular expression`);
      }
      if (verdict === "unsafe") {
        return fail(
          `${at}.pattern is rejected as unsafe: a quantifier applied to a group that ` +
            `itself quantifies or alternates (e.g. "(a+)+"), or two adjacent unbounded ` +
            `quantifiers over overlapping characters (e.g. ".*.*"), can hang the hook ` +
            `receiver. Try lifting the quantifier off the group.`,
        );
      }
    }

    if (typeof r.channels !== "object" || r.channels === null || Array.isArray(r.channels)) {
      return fail(`${at}.channels must be an object`);
    }
    const channels: Partial<Record<RuleChannel, boolean>> = {};
    for (const [key, value] of Object.entries(r.channels as Record<string, unknown>)) {
      if (!(RULE_CHANNELS as readonly string[]).includes(key)) {
        return fail(`${at}.channels has unknown channel "${key}"`);
      }
      if (typeof value !== "boolean") return fail(`${at}.channels.${key} must be boolean`);
      channels[key as RuleChannel] = value;
    }

    let severity: RuleSeverity | undefined;
    if (r.severity !== undefined) {
      if (!(RULE_SEVERITIES as readonly string[]).includes(r.severity as string)) {
        return fail(`${at}.severity must be one of: ${RULE_SEVERITIES.join(", ")}`);
      }
      severity = r.severity as RuleSeverity;
    }

    let events: string[] | undefined;
    if (r.events !== undefined) {
      if (!Array.isArray(r.events)) return fail(`${at}.events must be an array`);
      for (const e of r.events) {
        if (typeof e !== "string" || !VALID_EVENT_NAMES.has(e)) {
          return fail(`${at}.events contains an unknown hook event: ${String(e)}`);
        }
      }
      events = [...(r.events as string[])];
    }

    let projectSlug: string | undefined;
    if (r.projectSlug !== undefined) {
      if (typeof r.projectSlug !== "string" || r.projectSlug.length > 128) {
        return fail(`${at}.projectSlug must be a string ≤ 128 chars`);
      }
      projectSlug = r.projectSlug || undefined;
    }

    let cooldownSec: number | undefined;
    if (r.cooldownSec !== undefined) {
      if (typeof r.cooldownSec !== "number" || !Number.isFinite(r.cooldownSec)) {
        return fail(`${at}.cooldownSec must be a finite number`);
      }
      if (r.cooldownSec < 0 || r.cooldownSec > MAX_COOLDOWN_SEC) {
        return fail(`${at}.cooldownSec must be between 0 and ${MAX_COOLDOWN_SEC}`);
      }
      cooldownSec = r.cooldownSec;
    }

    rules.push({
      id: r.id,
      name: r.name.trim(),
      enabled: r.enabled,
      field: r.field as RuleField,
      op,
      pattern: r.pattern,
      channels,
      ...(severity ? { severity } : {}),
      ...(events ? { events } : {}),
      ...(projectSlug ? { projectSlug } : {}),
      ...(cooldownSec !== undefined ? { cooldownSec } : {}),
    });
  }

  return { ok: true, rules };
}
