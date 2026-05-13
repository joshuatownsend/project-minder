import type { PluginEntry, LintFinding } from "../../types";

/**
 * Vendored plugin lint rules — surface actionable issues from the merged
 * plugin registry (installed + enabled + blocked states).
 */
export function runPluginRules(plugins: PluginEntry[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...blockedButEnabled(plugins));
  findings.push(...enabledWithoutVersion(plugins));
  return findings;
}

/**
 * A plugin that is both blocked AND enabled is a configuration conflict.
 * The block wins in Claude Code, so the plugin won't run — but the enabled
 * entry is dead config that will surprise the user.
 */
function blockedButEnabled(plugins: PluginEntry[]): LintFinding[] {
  return plugins
    .filter((p) => p.blocked && p.enabled)
    .map((p) => ({
      target: "plugin" as const,
      code: "plugin/blocked-but-enabled",
      severity: "P1" as const,
      title: `Plugin "${p.name}" is both enabled and blocked — it will not run`,
      fix: `Remove "${p.name}" from the enabled list, or remove it from the blocklist if you want it to run.`,
      penalty: 5,
      engine: "vendored" as const,
    }));
}

/**
 * An installed plugin without a pinned version may silently update to a
 * breaking release. P2 guidance: pin with a specific version or commit SHA.
 */
function enabledWithoutVersion(plugins: PluginEntry[]): LintFinding[] {
  return plugins
    .filter((p) => p.enabled && !p.blocked && !p.version && !p.gitCommitSha)
    .map((p) => ({
      target: "plugin" as const,
      code: "plugin/unpinned-version",
      severity: "P2" as const,
      title: `Plugin "${p.name}" has no pinned version or commit SHA`,
      fix: `Pin the plugin to a specific version or commit SHA to prevent silent breaking updates. Use \`claudelint install-plugin ${p.name}@<version>\` to re-install pinned.`,
      penalty: 2,
      engine: "vendored" as const,
    }));
}
