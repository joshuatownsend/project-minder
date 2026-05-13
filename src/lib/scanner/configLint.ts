import type { ClaudeMdAuditInfo, LintReport } from "../types";
import { runLintEngine } from "../lint/engine";

/**
 * Scan-time entry point for the workspace config linter.
 *
 * `projectPath` is unused in Wave A (adapter-only) but will be passed to
 * the `claude-code-lint` library pass in Wave B.
 *
 * Inputs are narrowed to exactly what each wave uses to avoid assembling
 * a half-built ProjectData inside the orchestrator.
 */
export async function runConfigLint(
  _projectPath: string,
  inputs: { claudeMdAudit: ClaudeMdAuditInfo },
): Promise<LintReport> {
  return runLintEngine({ claudeMdAudit: inputs.claudeMdAudit });
}
