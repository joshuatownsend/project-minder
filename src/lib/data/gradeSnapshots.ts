import "server-only";
import type DatabaseT from "better-sqlite3";
import type { WasteGrade } from "@/lib/scanner/wasteOptimizer";
import { getDb, prepCached } from "@/lib/db/connection";
import { ensureSchemaReady } from "@/lib/data";

// Item 4b — daily project-grade snapshots + trend classification.
//
// One row per (project, calendar day) in `project_grade_snapshots`. The trend
// layer compares today's freshly-computed grade against the most-recent prior
// day's snapshot and labels the project new / improving / declining / stable.
//
// Everything here is BEST-EFFORT and enhancement-only: a missing driver,
// MINDER_USE_DB=0, an init failure, or a SQL error degrades to "no trend"
// (the dashboard's grade chips are unaffected). No path throws.
//
// `now` is injectable through both the write and the classify path so the
// snapshot date and the "prior = most-recent date < today" comparison derive
// from a single instant — tests pin it to make "yesterday vs today"
// deterministic.

/** Project-level grade movement, at grade-letter granularity. Same label set
 *  on the dashboard card and the per-project Efficiency tab so the two views
 *  never disagree. (Per-finding "resolved" is a finer granularity we don't
 *  store — snapshots are grade + counts, not per-finding rows.) */
export type GradeTrend = "new" | "improving" | "declining" | "stable";

export interface GradeSnapshotRow {
  slug: string;
  grade: WasteGrade;
  counts: { high: number; medium: number; low: number };
}

// Lower rank = better grade. Trend is classified on the letter only; the
// stored counts are the snapshot's substance (and a future numeric delta),
// not the trend signal.
const GRADE_RANK: Record<WasteGrade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

/**
 * Local YYYY-MM-DD for `now`. Deliberately local (not UTC) so a snapshot's
 * day boundary matches the user's calendar day — the same posture the usage
 * "today" period uses. Injectable for deterministic tests.
 */
export function snapshotDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Grade-letter movement: a better letter (lower rank) is "improving". */
export function classifyGradeTrend(
  prior: WasteGrade | null,
  current: WasteGrade
): GradeTrend {
  if (prior === null) return "new";
  const delta = GRADE_RANK[current] - GRADE_RANK[prior];
  if (delta < 0) return "improving";
  if (delta > 0) return "declining";
  return "stable";
}

/**
 * Open the DB only when it's genuinely ready, else null. Mirrors the data
 * façade's gate (`ensureSchemaReady` runs migrations; `getDb` opens the
 * handle) but swallows every failure instead of throwing — snapshots must
 * never break grade serving.
 */
async function readySnapshotDb(): Promise<DatabaseT.Database | null> {
  if (process.env.MINDER_USE_DB === "0") return null;
  try {
    const init = await ensureSchemaReady();
    if (!init.available) return null;
    return await getDb();
  } catch {
    return null;
  }
}

const UPSERT_SQL = `
  INSERT INTO project_grade_snapshots
    (project_slug, snapshot_date, grade, high_count, med_count, low_count, created_at_ms)
  VALUES (@slug, @date, @grade, @high, @med, @low, @createdAt)
  ON CONFLICT(project_slug, snapshot_date) DO UPDATE SET
    grade         = excluded.grade,
    high_count    = excluded.high_count,
    med_count     = excluded.med_count,
    low_count     = excluded.low_count,
    created_at_ms = excluded.created_at_ms
`;

/**
 * Upsert today's snapshot for each row in a single transaction. Idempotent on
 * (project_slug, snapshot_date): repeated runs within a day overwrite that
 * day's row (last grade of the day wins), never duplicate it. Both callers —
 * the efficiency-grade cache (bulk) and the per-project route (single via
 * `recordGradeSnapshot`) — go through this one helper so the row shape and
 * date logic can't drift.
 */
export async function recordGradeSnapshots(
  rows: GradeSnapshotRow[],
  now: Date = new Date()
): Promise<void> {
  if (rows.length === 0) return;
  const db = await readySnapshotDb();
  if (!db) return;
  const date = snapshotDate(now);
  const createdAt = now.getTime();
  try {
    const stmt = prepCached(db, UPSERT_SQL);
    const txn = db.transaction((rs: GradeSnapshotRow[]) => {
      for (const r of rs) {
        stmt.run({
          slug: r.slug,
          date,
          grade: r.grade,
          high: r.counts.high,
          med: r.counts.medium,
          low: r.counts.low,
          createdAt,
        });
      }
    });
    txn(rows);
  } catch {
    // Enhancement-only — a snapshot write failure is never surfaced.
  }
}

/** Single-row convenience over `recordGradeSnapshots`. */
export async function recordGradeSnapshot(
  row: GradeSnapshotRow,
  now: Date = new Date()
): Promise<void> {
  return recordGradeSnapshots([row], now);
}

interface PriorGradeRow {
  project_slug: string;
  grade: WasteGrade;
}

/**
 * Classify the trend for every slug in `current` against its most-recent
 * snapshot strictly BEFORE today, in one query (no N+1). Slugs with no prior
 * snapshot classify as "new". Returns `{}` when the DB is unavailable — the
 * caller renders no trend indicator rather than a misleading one.
 */
export async function loadGradeTrends(
  current: Record<string, WasteGrade>,
  now: Date = new Date()
): Promise<Record<string, GradeTrend>> {
  const slugs = Object.keys(current);
  if (slugs.length === 0) return {};
  const db = await readySnapshotDb();
  if (!db) return {};
  const date = snapshotDate(now);
  try {
    // Most-recent prior snapshot per project. The PK (project_slug,
    // snapshot_date) serves both the GROUP BY MAX and the self-join.
    const rows = prepCached(
      db,
      `SELECT s.project_slug AS project_slug, s.grade AS grade
         FROM project_grade_snapshots s
         JOIN (
           SELECT project_slug, MAX(snapshot_date) AS max_date
             FROM project_grade_snapshots
            WHERE snapshot_date < @date
            GROUP BY project_slug
         ) m ON m.project_slug = s.project_slug AND m.max_date = s.snapshot_date`
    ).all({ date }) as PriorGradeRow[];
    const prior = new Map(rows.map((r) => [r.project_slug, r.grade]));
    const trends: Record<string, GradeTrend> = {};
    for (const slug of slugs) {
      trends[slug] = classifyGradeTrend(prior.get(slug) ?? null, current[slug]);
    }
    return trends;
  } catch {
    return {};
  }
}

/**
 * Trend for a single project against its most-recent prior-day snapshot.
 * Returns `null` when the DB is unavailable (render no indicator); "new" when
 * the DB is healthy but the project has no prior snapshot yet.
 */
export async function loadGradeTrend(
  slug: string,
  currentGrade: WasteGrade,
  now: Date = new Date()
): Promise<GradeTrend | null> {
  const db = await readySnapshotDb();
  if (!db) return null;
  const date = snapshotDate(now);
  try {
    const row = prepCached(
      db,
      `SELECT grade FROM project_grade_snapshots
        WHERE project_slug = @slug AND snapshot_date < @date
        ORDER BY snapshot_date DESC LIMIT 1`
    ).get({ slug, date }) as { grade: WasteGrade } | undefined;
    return classifyGradeTrend(row?.grade ?? null, currentGrade);
  } catch {
    return null;
  }
}
