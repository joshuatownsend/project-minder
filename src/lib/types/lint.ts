import type { AuditFindingSeverity } from "./audit";

// ---------------------------------------------------------------------------
// Config Lint — workspace-wide surface audit
// ---------------------------------------------------------------------------

/** Claude Code config surface being linted. */
export type LintTarget =
  | "claude-md"
  | "skill"
  | "agent"
  | "command"
  | "settings"
  | "hook"
  | "mcp"
  | "plugin"
  | "output-style"
  | "lsp";

/** Which engine produced a finding. */
export type LintEngine = "adapter" | "library" | "vendored";

/** A single config-lint finding. Compatible with `AuditFindingSeverity` so
 *  existing severity-tone UI helpers work without changes. */
export interface LintFinding {
  target: LintTarget;
  /** Namespaced rule code, e.g. "claude-md/long-index", "skill/missing-frontmatter". */
  code: string;
  severity: AuditFindingSeverity;
  title: string;
  fix: string;
  /** Penalty weight preserved verbatim from the source finding (0 for informational). */
  penalty: number;
  engine: LintEngine;
  file?: string;
  docsUrl?: string;
}

export interface LintReport {
  findings: LintFinding[];
  countsByTarget: Partial<Record<LintTarget, { P0: number; P1: number; P2: number }>>;
  totalCounts: { P0: number; P1: number; P2: number };
  engineErrors: { engine: LintEngine; target?: LintTarget; message: string }[];
  /** Strict-gate signal: `true` when any P0 or P1 finding exists. This is the
   *  one authoritative definition of "the config fails strict lint" — a CI
   *  badge or `?tab=config-lint` deep link renders fail-state on this flag
   *  rather than re-deriving the P0/P1 rule in each consumer. Derivable from
   *  `totalCounts`, but materialized so the contract lives in exactly one
   *  place (computed in `buildReport`) and rides along in API/MCP responses. */
  hasBlocking: boolean;
}

// ---------------------------------------------------------------------------
// Config formatter — wraps `claudelint format` (markdownlint + prettier)
// ---------------------------------------------------------------------------

/** Per-file outcome of an apply-mode format run. */
export interface FormatFileResult {
  /** Project-relative path, as the formatter reports it. */
  file: string;
  /** Backup id captured before the rewrite, or `null` when snapshotting
   *  failed (the fix still proceeds — a missing backup never blocks apply)
   *  or the file turned out unchanged (its snapshot is rolled back). */
  backupId: string | null;
  /** True when the on-disk bytes actually changed. */
  changed: boolean;
}

/** Non-mutating "what would change" result. */
export interface FormatCheckResult {
  mode: "check";
  /** Project-relative paths the formatter would rewrite. Empty = clean. */
  filesNeedingFormat: string[];
  /** Populated when the CLI could not be run (spawn/timeout); files is []. */
  engineError?: string;
}

/** Result of an apply-mode run that snapshotted then rewrote files. */
export interface FormatApplyResult {
  mode: "apply";
  formatted: FormatFileResult[];
  engineError?: string;
}
