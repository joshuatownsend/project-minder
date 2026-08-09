import "server-only";
import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";
import { periodSinceIso } from "@/lib/usage/period";
import { buildEngagementReport, projectKeyOf, type EngagementTurnRow } from "@/lib/engagement/aggregator";
import type { EngagementConfig, EngagementReport } from "@/lib/engagement/types";
import { startOfLocalDay, type ConcurrencyPolicy } from "@/lib/engagement/allocate";

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
  /** Claude-home discriminator (`ProjectData.usageHomeKey`). Two homes with
   *  identical path layouts share a slug and an encoded directory name, so
   *  without this a scoped report can include the other home's hours. */
  home?: string;
  policy?: ConcurrencyPolicy;
}

/**
 * Period lower bound, in the **requested** timezone.
 *
 * Only `today` is calendar-aligned; every other period is a rolling window
 * where the host's zone is irrelevant. `getPeriodStart` computes that midnight
 * with `setHours(0,0,0,0)` — server-local — so on a host in a different zone
 * from the viewer the Today window and the Today day-buckets disagreed.
 */
function periodStartMs(period: string, timeZone: string, now = Date.now()): number | null {
  if (period === "today") return startOfLocalDay(now, timeZone);
  const iso = periodSinceIso(period);
  return iso === null ? null : Date.parse(iso);
}

/**
 * How far before the period boundary to over-fetch so a gap straddling it can
 * still be recognised as attended.
 *
 * An attended gap spans at most `runCap + responseThreshold` of *credited*
 * time, but its opening prompt can sit arbitrarily far back when the agent ran
 * long — so this is a pragmatic bound rather than a proof. 24 hours covers
 * every gap observed on the reference corpus (longest agent-busy span: 8.5 h)
 * with an order of magnitude to spare, and the fetched lead-in is clipped
 * back out before anything is billed.
 */
const BOUNDARY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function loadEngagementReportFromSql(
  db: DatabaseT.Database,
  options: EngagementQueryOptions,
): EngagementReport {
  const { period, timeZone, config, project, home, policy } = options;
  const clipFromMs = periodStartMs(period, timeZone);
  const periodStart =
    clipFromMs === null ? null : new Date(clipFromMs - BOUNDARY_LOOKBACK_MS).toISOString();

  // The scoped query still loads *all* projects' turns when `project` is set,
  // because per-project allocated hours are only meaningful relative to what
  // else was running at the same time. Filtering in SQL would silently turn a
  // de-overlapped number back into a raw one.
  const rows = prepCached(
    db,
    `SELECT
       s.project_dir_name     AS projectDirName,
       s.project_slug         AS projectSlug,
       s.home_key             AS homeKey,
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

  // Counted against the true period bound, not the over-fetched one — this is
  // a disclosure figure shown to the user ("N automated sessions excluded"),
  // so it must describe the window they asked for.
  const excluded = prepCached(
    db,
    `SELECT COUNT(*) AS n FROM sessions s
     WHERE s.entrypoint LIKE 'sdk-%'
       AND (@bound IS NULL OR s.end_ts >= @bound)`,
  ).get({ bound: clipFromMs === null ? null : new Date(clipFromMs).toISOString() }) as { n: number };

  const report = buildEngagementReport(rows, {
    period,
    timeZone,
    config,
    policy,
    clipFromMs,
    excludedAutomatedSessions: excluded?.n ?? 0,
  });

  if (!project) return report;

  // Scoping happens after allocation so the retained rows carry the
  // concurrency discount earned against every other project.
  //
  // The home check is one-directional on purpose: when the caller supplies a
  // home, only rows from that home qualify; when it doesn't, every home
  // matching the slug is kept, which is the single-home case and the
  // "show me everything for this project" case alike.
  const match = (p: { projectSlug: string | null; projectDirName: string; homeKey?: string }) =>
    (p.projectSlug === project || p.projectDirName === project) &&
    (!home || p.homeKey === home);

  const kept = report.byProject.filter(match);
  const keptKeys = new Set(kept.map((p) => projectKeyOf(p.projectDirName, p.homeKey)));

  const byDay = report.byDay
    .map((d) => {
      const byProject = d.byProject.filter((p) =>
        keptKeys.has(projectKeyOf(p.projectDirName, p.homeKey)),
      );
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
