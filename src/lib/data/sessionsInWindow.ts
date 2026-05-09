import type DatabaseT from "better-sqlite3";
import { prepCached } from "@/lib/db/connection";

export interface SessionCostRow {
  startedAt: number;
  costUsd: number;
}

/**
 * Return all sessions whose time window overlaps [startMs, endMs] for the
 * given project. Used by the GSD planning tab to attribute cost to phases.
 *
 * Overlap condition: session started before endMs AND ended after startMs.
 */
export function loadSessionCostsInWindow(
  db: DatabaseT.Database,
  projectSlug: string,
  startMs: number,
  endMs: number,
): SessionCostRow[] {
  // start_ts/end_ts are stored as ISO strings; convert ms timestamps so
  // SQLite compares TEXT vs TEXT (lexicographic order works for ISO 8601).
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const rows = prepCached(
    db,
    `SELECT start_ts, cost_usd FROM sessions
     WHERE project_slug = ?
       AND end_ts   >= ?
       AND start_ts <= ?
     ORDER BY start_ts ASC`,
  ).all(projectSlug, startIso, endIso) as Array<{
    start_ts: number;
    cost_usd: number | null;
  }>;

  return rows.map((r) => ({
    startedAt: r.start_ts,
    costUsd: r.cost_usd ?? 0,
  }));
}
