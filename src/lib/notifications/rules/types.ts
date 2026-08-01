/**
 * Notification rules engine — types.
 *
 * Replaces the closed two-key `notificationPrefs.events` enum with an open
 * `{field, op, pattern} → channels` triple, so a new alert is a config edit
 * rather than a code change across four files.
 *
 * Pure types + constants only (no `server-only`): the Settings UI, the
 * `/api/config` validator, and the hook-route evaluator all import from here.
 */

/**
 * The field namespace rules match against.
 *
 * Deliberately a *curated* set rather than arbitrary JSON paths into Claude
 * Code's hook body. Two reasons:
 *   1. Stability — the wire format is Claude Code's, not ours. A rule written
 *      against `tool_input.file_path` silently stops matching when a field is
 *      renamed upstream; a rule written against `tool.input` keeps working
 *      because `fields.ts` absorbs the change in one place.
 *   2. Bounded cost — every field is length-capped before matching, which is
 *      what makes user-authored regex safe to run on a hot path.
 *
 * `any` is the escape hatch for "regex over the whole event" and concatenates
 * every text field below.
 */
export type RuleField =
  | "any"
  | "event"
  | "project"
  | "cwd"
  | "permissionMode"
  | "tool.name"
  | "tool.input"
  | "tool.response"
  | "tool.failed"
  | "tool.durationMs"
  | "prompt"
  | "message"
  | "model"
  | "agentType";

export const RULE_FIELDS: readonly RuleField[] = [
  "any",
  "event",
  "project",
  "cwd",
  "permissionMode",
  "tool.name",
  "tool.input",
  "tool.response",
  "tool.failed",
  "tool.durationMs",
  "prompt",
  "message",
  "model",
  "agentType",
] as const;

/** Human-facing labels + hints for the rule editor. */
export const RULE_FIELD_META: Readonly<Record<RuleField, { label: string; hint: string }>> = {
  "any": { label: "Any text", hint: "Every text field concatenated — the catch-all." },
  "event": { label: "Hook event", hint: "PreToolUse, PostToolUse, Stop, …" },
  "project": { label: "Project slug", hint: "Scope a rule to one project." },
  "cwd": { label: "Working directory", hint: "Full path the session is running in." },
  "permissionMode": { label: "Permission mode", hint: "default, acceptEdits, plan, bypassPermissions." },
  "tool.name": { label: "Tool name", hint: "Bash, Edit, Write, Read, Task, …" },
  "tool.input": { label: "Tool input", hint: "Command text, file path, patch body — where .env access shows up." },
  "tool.response": { label: "Tool response", hint: "Result text, including error messages." },
  "tool.failed": { label: "Tool failed", hint: "true / false — set on PostToolUse." },
  "tool.durationMs": { label: "Tool duration (ms)", hint: "Numeric — use greater-than for slow calls." },
  "prompt": { label: "Your prompt", hint: "Text you submitted (UserPromptSubmit)." },
  "message": { label: "Notification message", hint: "Claude Code's own notification text." },
  "model": { label: "Model", hint: "Set on SessionStart." },
  "agentType": { label: "Subagent type", hint: "Set on SubagentStop." },
};

/**
 * Match operators. `contains` / `equals` are case-insensitive because every
 * realistic use (`.env`, `Bash`, `bypassPermissions`) is a human-typed literal
 * where case sensitivity is a footgun, not a feature.
 */
export type RuleOperator = "contains" | "equals" | "regex" | "gt" | "lt";

export const RULE_OPERATORS: readonly RuleOperator[] = [
  "contains",
  "equals",
  "regex",
  "gt",
  "lt",
] as const;

export const RULE_OPERATOR_META: Readonly<Record<RuleOperator, { label: string; numeric: boolean }>> = {
  contains: { label: "contains", numeric: false },
  equals: { label: "equals", numeric: false },
  regex: { label: "matches regex", numeric: false },
  gt: { label: "is greater than", numeric: true },
  lt: { label: "is less than", numeric: true },
};

export type RuleChannel = "push" | "telegram" | "os";

export const RULE_CHANNELS: readonly RuleChannel[] = ["push", "telegram", "os"] as const;

/** Severity drives only presentation (icon/colour); it does not gate delivery. */
export type RuleSeverity = "info" | "warn" | "critical";

export const RULE_SEVERITIES: readonly RuleSeverity[] = ["info", "warn", "critical"] as const;

export interface NotificationRule {
  /** Stable id — used as the config key, the dedup key, and the React key. */
  id: string;
  /** Shown in the notification title. */
  name: string;
  enabled: boolean;
  field: RuleField;
  op: RuleOperator;
  /** Literal, regex source, or numeric threshold depending on `op`. */
  pattern: string;
  channels: Partial<Record<RuleChannel, boolean>>;
  severity?: RuleSeverity;
  /**
   * Restrict to specific hook events. Empty/absent = all events. A narrow
   * scope is both cheaper and less noisy: `.env`-access only makes sense on
   * PreToolUse / PostToolUse.
   */
  events?: string[];
  /** Restrict to one project slug. Absent = all projects. */
  projectSlug?: string;
  /**
   * Minimum seconds between deliveries for this rule (per project). Guards
   * against a rule on a common tool firing on every keystroke of a session.
   */
  cooldownSec?: number;
}

/** Result of a rule firing — what the dispatcher turns into a notification. */
export interface RuleMatch {
  rule: NotificationRule;
  /** The field value that matched, truncated for display. */
  excerpt: string;
  /** Project slug the event came from. */
  projectSlug: string;
}

/** Hard limits. Enforced by the `/api/config` validator *and* the matcher, so
 *  a rule hand-written into `.minder.json` cannot outrun the checks. */
export const MAX_RULES = 50;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_RULE_NAME_LENGTH = 80;
/** Per-field cap applied before matching. Bounds worst-case matcher cost. */
export const MAX_FIELD_LENGTH = 4_000;
/** The `any` field concatenates several capped fields, so it gets its own cap. */
export const MAX_ANY_LENGTH = 8_000;
export const DEFAULT_COOLDOWN_SEC = 60;
export const MAX_COOLDOWN_SEC = 24 * 60 * 60;
