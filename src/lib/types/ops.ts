import type { DatabaseInfo } from "./project";
import type { HostingTarget, DependabotUpdate } from "./cicd";

// ── OPERATIONS.md runbook (curated operational facts, living-checklist) ──────
// The ~30% of operational truth that can't be auto-detected: backups,
// monitoring/alerting, on-call/escalation, secrets/rotation, restore. Parsed
// from OPERATIONS.md and surfaced (alongside auto-detected ops) in the per-
// project Operations panel.

/** The five known runbook sections (mapped from `##` headings by a synonym
 *  table); unrecognized headings pass through as `other` so hand-written
 *  runbooks aren't silently dropped. */
export type OpsSectionKey =
  | "backups"
  | "monitoring"
  | "oncall"
  | "secrets"
  | "restore"
  | "other";

export interface OpsRunbookItem {
  text: string;
  done: boolean;        // `- [x]` vs `- [ ]` (recorded, not toggled in v1)
  details: string[];    // indented continuation lines
  lineNumber: number;   // 1-based, for a future writer
}

export interface OpsRunbookSection {
  key: OpsSectionKey;
  heading: string;      // verbatim `## ` heading text
  body: string;         // prose under the heading (non-checkbox lines)
  items: OpsRunbookItem[];
  line: number;         // 1-based heading line
}

export interface OperationsInfo {
  sections: OpsRunbookSection[];
  totalItems: number;
  pendingItems: number;
}

// ── Operations summary (derive-and-present layer over already-scanned fields) ─
// Composed by `deriveOpsSummary` (src/lib/ops/summary.ts) from fields Minder
// already populates — no new scanning. Serializable so the Operations panel can
// derive it client-side from the /api/projects payload.

export interface OpsCron {
  schedule: string;                 // raw cron expr
  path?: string;                    // vercel cron route, if any
  source: "vercel" | "workflow";
  sourcePath: string;
}

export interface OpsSummary {
  deployTargets: HostingTarget[];   // from CiCdInfo.hosting
  services: string[];               // from ProjectData.externalServices
  database?: DatabaseInfo;          // from ProjectData.database
  crons: OpsCron[];                 // vercelCrons + workflow schedule crons
  dependabot: DependabotUpdate[];   // from CiCdInfo.dependabot
  runbook?: OperationsInfo;         // from OPERATIONS.md; undefined when scanOps off / absent
  /** Honest auto-vs-curated coverage for the "fill your runbook" nudge. */
  coverage: { autoGroups: number; curatedSections: number; curatedTotal: 5 };
}
