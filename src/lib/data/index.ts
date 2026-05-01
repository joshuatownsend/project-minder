import "server-only";
import { aggregateUsage, generateUsageReport } from "@/lib/usage/aggregator";
import { getJsonlMaxMtime } from "@/lib/usage/parser";
import { getDb, isDriverLoaded } from "@/lib/db/connection";
import { initDb } from "@/lib/db/migrations";
import { loadFilteredUsageTurns, getDbMaxMtimeMs } from "./usageFromDb";
import type { UsageReport } from "@/lib/usage/types";

// Read-side data façade. Currently houses the two backends for
// `/api/usage`; subsequent slices will add `getSessions`, `getStats`, etc.
//
// Backend selection:
//
//   * **Default** — file-parse via `parseAllSessions()` + the existing
//     `globalThis` JSONL FileCache. Stable, well-tested, what every
//     production install runs today.
//
//   * **`MINDER_USE_DB=1`** — opt-in SQLite-backed path. Loads filtered
//     turns directly from the local index (`~/.minder/index.db`),
//     reconstructs `UsageTurn[]` with truncation parity to the file-parse
//     path, then runs the **same** aggregator. The structural perf win
//     (SUM/GROUP BY per dimension) lands in P2b-2.5 once we add per-turn
//     cost and per-category rollups; this slice's win is "skip the
//     1.1 GB JSONL re-parse on cold cache."
//
// Falls through to file-parse when the DB is unavailable (driver
// missing, init failure, no rows yet) so a misconfigured indexer never
// breaks `/api/usage`. The fall-through is logged once per process so
// operators can spot a silently-degraded DB mode.

const FLAG = "MINDER_USE_DB";

function dbModeRequested(): boolean {
  return process.env[FLAG] === "1";
}

let fallthroughLogged = false;
function logFallthroughOnce(reason: string): void {
  if (fallthroughLogged) return;
  fallthroughLogged = true;
  // eslint-disable-next-line no-console
  console.warn(`[data] ${FLAG}=1 set but DB-backed path unavailable: ${reason}. Falling back to file-parse.`);
}

export interface UsageBackendMeta {
  /** Which backend produced the report; surfaces in HTTP `X-Minder-Backend`. */
  backend: "db" | "file";
  /** Max input mtime — feeds ETag computation upstream. */
  maxMtimeMs: number;
}

export interface UsageResult {
  report: UsageReport;
  meta: UsageBackendMeta;
}

/**
 * Run the usage report through whichever backend is enabled. Always
 * returns a valid `UsageReport` — the DB backend transparently falls
 * back to file-parse on any failure.
 */
export async function getUsage(
  period: "today" | "week" | "month" | "all",
  project?: string
): Promise<UsageResult> {
  if (dbModeRequested() && isDriverLoaded()) {
    try {
      const init = await initDb();
      if (!init.available) {
        logFallthroughOnce(init.error?.message ?? "schema unavailable");
      } else {
        const db = await getDb();
        if (!db) {
          logFallthroughOnce("getDb returned null after init");
        } else {
          const turns = loadFilteredUsageTurns(db, period, project);
          const report = await aggregateUsage(turns, period);
          return {
            report,
            meta: { backend: "db", maxMtimeMs: getDbMaxMtimeMs(db) },
          };
        }
      }
    } catch (err) {
      logFallthroughOnce((err as Error).message);
    }
  }

  // File-parse backend. `getJsonlMaxMtime()` is captured AFTER report
  // generation — the report's parseAllSessions warms the FileCache, so a
  // pre-call read would return 0 on a cold process.
  const report = await generateUsageReport(period, project);
  return {
    report,
    meta: { backend: "file", maxMtimeMs: getJsonlMaxMtime() },
  };
}
