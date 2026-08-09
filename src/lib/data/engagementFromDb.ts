import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import { periodSinceIso } from "@/lib/usage/period";
import { buildEngagementReport, type EngagementTurnRow } from "@/lib/engagement/aggregator";
import type { EngagementConfig, EngagementReport } from "@/lib/engagement/types";
import type { ConcurrencyPolicy } from "@/lib/engagement/allocate";

/**
 * SQL-backed human-engagement report.
 *
 * **SQL-only by design.** The equivalent file-parse path would have to walk and
 * timestamp-sort every JSONL turn in `~/.claude/projects` for the period; on
 * this corpus that is millions of lines for a report the DB answers from an
 * index. `MINDER_USE_DB=0` therefore yields no engagement report rather than a
 * slow one — the route says so explicitly instead of hanging.
 */

/**
 * Automated sessions are excluded at the SQL boundary, not in JS.
 *
 * `entrypoint LIKE 'sdk-%'` is the single highest-value filter in this feature.
 * A 2026-08-09 corpus audit found one cron-driven project contributing 3,479
 * `sdk-cli` sessions whose scripted opening prompts ("You are the staff
 * historian for ...") are indistinguishable from human prose by text alone.
 * Without this clause that project books ~24 h of phantom attended time.
 *
 * NULL / `unknown` entrypoints are **kept**, matching `isAutomatedEntrypoint`:
 * absence of evidence is not evidence of automation, and guessing would push
 * unclassifiable sessions into whichever bucket the guess favoured.
 */
const NOT_AUTOMATED = "(s.entrypoint IS NULL OR s.entrypoint NOT LIKE 'sdk-%')";

export interface EngagementQueryOptions {
  period: string;
  timeZone: string;
  config: EngagementConfig;
  /** Route slug to scope to; omitted ⇒ every project (required for a
   *  cross-project timecard, since allocation needs the full picture). */
  project?: string;
  policy?: ConcurrencyPolicy;
}

export function loadEngagementReportFromSql(
  db: DatabaseT.Database,
  options: EngagementQueryOptions,
): EngagementReport {
  const { period, timeZone, config, project, policy } = options;
  const periodStart = periodSinceIso(period);

  // The scoped query still loads *all* projects' turns when `project` is set,
  // because per-project allocated hours are only meaningful relative to what
  // else was running at the same time. Filtering in SQL would silently turn a
  // de-overlapped number back into a raw one.
  const rows = prepCached(
    db,
    `SELECT
       s.project_dir_name     AS projectDirName,
       s.project_slug         AS projectSlug,
       t.ts                   AS ts,
       t.role                 AS role,
       t.text_preview         AS textPreview,
       t.tool_result_preview  AS toolResultPreview
     FROM turns t JOIN sessions s USING (session_id)
     WHERE t.is_sidechain = 0
       AND ${NOT_AUTOMATED}
       AND (@periodStart IS NULL OR t.ts >= @periodStart)
     ORDER BY t.ts`,
  ).all({ periodStart }) as EngagementTurnRow[];

  const excluded = prepCached(
    db,
    `SELECT COUNT(*) AS n FROM sessions s
     WHERE s.entrypoint LIKE 'sdk-%'
       AND (@periodStart IS NULL OR s.end_ts >= @periodStart)`,
  ).get({ periodStart }) as { n: number };

  const report = buildEngagementReport(rows, {
    period,
    timeZone,
    config,
    policy,
    excludedAutomatedSessions: excluded?.n ?? 0,
  });

  if (!project) return report;

  // Scoping happens after allocation so the retained rows carry the
  // concurrency discount earned against every other project.
  const match = (slug: string | null, dir: string) => slug === project || dir === project;
  const kept = report.byProject.filter((p) => match(p.projectSlug, p.projectDirName));
  const keptKeys = new Set(kept.map((p) => p.projectDirName));

  const byDay = report.byDay
    .map((d) => {
      const byProject = d.byProject.filter((p) => keptKeys.has(p.projectDirName));
      return {
        date: d.date,
        totalHours: round2(byProject.reduce((s, p) => s + p.hours, 0)),
        byProject,
      };
    })
    .filter((d) => d.totalHours > 0);

  return {
    ...report,
    byProject: kept,
    byDay,
    totalHours: round2(kept.reduce((s, p) => s + p.allocatedHours, 0)),
    rawHours: round2(kept.reduce((s, p) => s + p.rawHours, 0)),
    overlapHours: round2(
      Math.max(0, kept.reduce((s, p) => s + p.rawHours - p.allocatedHours, 0)),
    ),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
