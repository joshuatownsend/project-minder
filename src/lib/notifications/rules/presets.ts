/**
 * Notification rules engine — curated presets.
 *
 * One-click starting points in the Settings rule editor. Every preset uses
 * `contains` / `equals` / `gt` rather than `regex`, deliberately: presets are
 * then safe by construction and unaffected by the regex-safety policy in
 * `matcher.ts`. Users reach for `regex` when a literal won't do; the shipped
 * set never needs to.
 *
 * `id` is a stable slug so re-adding a preset the user deleted doesn't
 * duplicate it, and so cooldown state keyed on the id survives an edit.
 */

import { DEFAULT_COOLDOWN_SEC, type NotificationRule } from "./types";

export interface RulePreset {
  rule: NotificationRule;
  /** Why this rule is worth having — shown under the preset button. */
  rationale: string;
}

const TOOL_EVENTS = ["PreToolUse", "PostToolUse"];

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    rule: {
      id: "preset-env-access",
      name: "Secret file accessed",
      enabled: true,
      field: "tool.input",
      op: "contains",
      pattern: ".env",
      events: TOOL_EVENTS,
      channels: { push: true, os: true },
      severity: "critical",
      cooldownSec: 30,
    },
    rationale:
      "Fires when any tool call touches a path or command containing `.env`. Across a whole project tree this is the highest-value alert: it tells you the moment a session reads credentials, whether or not you asked it to.",
  },
  {
    rule: {
      id: "preset-permission-bypass",
      name: "Running with permissions bypassed",
      enabled: true,
      field: "permissionMode",
      op: "equals",
      pattern: "bypassPermissions",
      channels: { push: true, os: true },
      severity: "critical",
      cooldownSec: 300,
    },
    rationale:
      "Claude Code reports its permission mode on every hook. This catches a session running unattended in bypass mode — the state where nothing else will ask you first.",
  },
  {
    rule: {
      id: "preset-tool-error",
      name: "Tool call failed",
      enabled: true,
      field: "tool.failed",
      op: "equals",
      pattern: "true",
      events: ["PostToolUse"],
      channels: { os: true },
      severity: "warn",
      cooldownSec: DEFAULT_COOLDOWN_SEC,
    },
    rationale:
      "Any tool returning an error or a non-zero exit code. Noisy by nature (a failing test run trips it repeatedly) — the 60s cooldown keeps it to one ping per burst.",
  },
  {
    rule: {
      id: "preset-destructive-shell",
      name: "Destructive shell command",
      enabled: true,
      field: "tool.input",
      op: "contains",
      pattern: "rm -rf",
      events: TOOL_EVENTS,
      channels: { push: true, os: true },
      severity: "critical",
      cooldownSec: 30,
    },
    rationale:
      "Recursive deletes. On Windows this is worth watching even when it looks scoped, because a junction inside the target can send the delete somewhere you did not intend.",
  },
  {
    rule: {
      id: "preset-force-push",
      name: "Force push",
      enabled: true,
      field: "tool.input",
      op: "contains",
      pattern: "push --force",
      events: TOOL_EVENTS,
      channels: { push: true, os: true },
      severity: "critical",
      cooldownSec: 30,
    },
    rationale:
      "Rewriting published history is the one git operation that can lose a colleague's work. Catches `--force` (not `--force-with-lease`, which is the safe form and reads differently).",
  },
  {
    rule: {
      id: "preset-slow-tool",
      name: "Tool call took over a minute",
      enabled: false,
      field: "tool.durationMs",
      op: "gt",
      pattern: "60000",
      events: ["PostToolUse"],
      channels: { os: true },
      severity: "info",
      cooldownSec: DEFAULT_COOLDOWN_SEC,
    },
    rationale:
      "A build or test run that has gone long. Off by default — on this project a 5-minute `pnpm build` is normal, not news.",
  },
];

/** Deep-copy a preset so the caller can edit it without mutating the module. */
export function instantiatePreset(preset: RulePreset): NotificationRule {
  return {
    ...preset.rule,
    channels: { ...preset.rule.channels },
    events: preset.rule.events ? [...preset.rule.events] : undefined,
  };
}
