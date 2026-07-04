export type AuditFindingSeverity = "P0" | "P1" | "P2";

export type ClaudeMdAuditCode =
  | "no-claude-md"
  | "long-index"
  | "file-size"
  | "inline-bloat"
  | "missing-topic-files"
  | "rules-volume"
  | "reference-tiering";

export interface ClaudeMdAuditFinding {
  code: ClaudeMdAuditCode;
  severity: AuditFindingSeverity;
  title: string;
  fix: string;
  penalty: number;
  file?: string;
}

/** Audit result for the absent-CLAUDE.md case. Carries only the
 *  discriminant + a single P1 finding so consumers don't have to
 *  branch on `hasClaudeMd ? presentFields : zeroFields`. */
export interface ClaudeMdAuditAbsent {
  hasClaudeMd: false;
  findings: ClaudeMdAuditFinding[];
}

/** Audit result for the present-CLAUDE.md case. Carries the full
 *  measurement shape (score, line counts, etc.) — TypeScript narrows
 *  on `hasClaudeMd === true` so callers get all fields without `!`. */
export interface ClaudeMdAuditPresent {
  hasClaudeMd: true;
  score: number;            // 0-100, 100 = healthy
  projectLines: number;     // project CLAUDE.md only (post @import-expand) — what `long-index` trips on
  importCount: number;
  fileBytes: number;
  rulesLines: number;
  rulesFileCount: number;
  findings: ClaudeMdAuditFinding[];
}

/** Discriminated union — switch on `hasClaudeMd` to access measurement
 *  fields without optional-chaining. The scanner always produces one
 *  of these two variants (no `undefined` case). */
export type ClaudeMdAuditInfo = ClaudeMdAuditAbsent | ClaudeMdAuditPresent;
