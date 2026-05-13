import type { ClaudeMdAuditInfo, LintFinding } from "../../types";

/**
 * Re-emits existing `ClaudeMdAuditFinding[]` into the unified `LintFinding`
 * shape. The CLAUDE.md audit keeps running unchanged as the authoritative
 * scorer; this adapter makes its findings visible in the config-lint panel
 * without duplicating logic.
 *
 * Penalty values are passed verbatim so the severity-weighted display in the
 * config-lint panel matches the CLAUDE.md health panel.
 */
export function adaptClaudeMdFindings(audit: ClaudeMdAuditInfo): LintFinding[] {
  return audit.findings.map((f) => ({
    target: "claude-md" as const,
    code: `claude-md/${f.code}`,
    severity: f.severity,
    title: f.title,
    fix: f.fix,
    penalty: f.penalty,
    engine: "adapter" as const,
    ...(f.file !== undefined ? { file: f.file } : {}),
  }));
}
