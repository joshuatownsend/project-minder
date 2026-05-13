import type { ClaudeMdAuditInfo, McpServer, LintReport } from "../types";
import { runLintEngine } from "../lint/engine";

/** Inputs narrowed to what each wave uses; widened wave-by-wave. */
export interface ConfigLintInputs {
  claudeMdAudit: ClaudeMdAuditInfo;
  /** Wave B+: all MCP servers across sources for cross-scope rules. */
  mcpServers?: McpServer[];
}

/**
 * Scan-time entry point for the workspace config linter.
 * Passes `projectPath` separately so the library CLI can run from the
 * project directory; structured inputs carry pre-loaded scanner data.
 */
export async function runConfigLint(
  projectPath: string,
  inputs: ConfigLintInputs,
): Promise<LintReport> {
  return runLintEngine({
    claudeMdAudit: inputs.claudeMdAudit,
    projectPath,
    mcpServers: inputs.mcpServers,
  });
}
