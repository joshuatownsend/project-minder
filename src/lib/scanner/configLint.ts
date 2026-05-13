import type { ClaudeMdAuditInfo, HookEntry, McpServer, LintReport } from "../types";
import { runLintEngine } from "../lint/engine";
import { getUserConfig } from "../userConfigCache";

/** Inputs narrowed to what each wave uses; widened wave-by-wave. */
export interface ConfigLintInputs {
  claudeMdAudit: ClaudeMdAuditInfo;
  /** Wave B+: all MCP servers across sources for cross-scope rules. */
  mcpServers?: McpServer[];
  /** Wave C+: project-scope hook entries; user-scope fetched internally. */
  hooks?: HookEntry[];
}

/**
 * Scan-time entry point for the workspace config linter.
 * `projectPath` is passed separately so the library CLI runs from the
 * project directory. User-scope hooks and plugins are fetched via the
 * `getUserConfig()` global cache (5-min TTL, safe to call per-project).
 */
export async function runConfigLint(
  projectPath: string,
  inputs: ConfigLintInputs,
): Promise<LintReport> {
  // Fetch user-scope config (hooks + plugins) from the global cache.
  // Failure is non-fatal — we degrade to project-scope only.
  const userCfg = await getUserConfig().catch(() => null);

  const allHooks: HookEntry[] = [
    ...(inputs.hooks ?? []),
    ...(userCfg?.hooks.entries ?? []),
  ];

  return runLintEngine({
    claudeMdAudit: inputs.claudeMdAudit,
    projectPath,
    mcpServers: inputs.mcpServers,
    hooks: allHooks.length > 0 ? allHooks : undefined,
    plugins: userCfg?.plugins.plugins,
  });
}
