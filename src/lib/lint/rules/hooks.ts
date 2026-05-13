import type { HookEntry, LintFinding } from "../../types";

/**
 * Vendored hook lint rules — focused on issues the library CLI already
 * validates for script existence and event names, but not runtime safety.
 */
export function runHookRules(entries: HookEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...hookCommandsWithoutTimeout(entries));
  findings.push(...duplicateEventHandlers(entries));
  return findings;
}

/**
 * Flag hook commands that have no `timeout` set. A runaway hook blocks the
 * entire Claude Code lifecycle event (PreToolUse, PostToolUse, etc.) until
 * the shell command completes. P2: strongly recommended but not blocking.
 *
 * Emits one finding per hook-event + source combination that has at least
 * one untimed command, to avoid flooding on hooks with many commands.
 */
function hookCommandsWithoutTimeout(entries: HookEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const entry of entries) {
    const untimed = entry.commands.filter((c) => c.timeout === undefined);
    if (untimed.length === 0) continue;
    const label = entry.matcher ? `${entry.event}(${entry.matcher})` : entry.event;
    findings.push({
      target: "hook",
      code: "hook/no-timeout",
      severity: "P2",
      title: `Hook "${label}" has ${untimed.length} command${untimed.length > 1 ? "s" : ""} without a timeout`,
      fix: `Add a \`timeout\` (milliseconds) to each hook command to prevent runaway hooks from blocking Claude Code. Example: \`{ "type": "command", "command": "...", "timeout": 5000 }\`.`,
      penalty: 2,
      engine: "vendored",
      file: entry.sourcePath,
    });
  }
  return findings;
}

/**
 * Flag the same lifecycle event registered more than once from the same
 * source + matcher. Duplicate registrations are legal but usually accidental
 * and make hooks harder to reason about.
 */
function duplicateEventHandlers(entries: HookEntry[]): LintFinding[] {
  const seen = new Map<string, HookEntry>();
  const findings: LintFinding[] = [];

  for (const entry of entries) {
    const key = `${entry.source}::${entry.sourcePath}::${entry.event}::${entry.matcher ?? ""}`;
    const prior = seen.get(key);
    if (prior) {
      const label = entry.matcher ? `${entry.event}(${entry.matcher})` : entry.event;
      findings.push({
        target: "hook",
        code: "hook/duplicate-event-handler",
        severity: "P2",
        title: `Hook event "${label}" registered more than once in ${entry.source} scope`,
        fix: `Merge duplicate hook registrations for "${label}" into a single entry to make execution order explicit.`,
        penalty: 2,
        engine: "vendored",
        file: entry.sourcePath,
      });
    } else {
      seen.set(key, entry);
    }
  }
  return findings;
}
