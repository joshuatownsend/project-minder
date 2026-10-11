import "server-only";
import { getDb, prepCached } from "@/lib/db/connection";
import { dbModeRequested } from "@/lib/data";
import { readIndexCurrent } from "@/lib/db/ingestSettled";

/**
 * How long the set of indexed transcript paths is trusted before it is reloaded.
 * The set only grows between reloads, so a reload bounds how long a row that has
 * since disappeared (an index rebuild, a pruned session) can keep a file skipped.
 */
export const KNOWN_RELOAD_MS = 10 * 60_000;

export interface TranscriptStatFilter {
  /** False only when the index says `filePath` has not been written since `since`. */
  mustStat(filePath: string): boolean;
}

const g = globalThis as unknown as {
  __minderIndexedTranscripts?: { paths: Set<string>; loadedAt: number };
};

/**
 * Lets the live-status build skip transcripts the index already knows are old
 * (#672).
 *
 * Without it, every rebuild stats every transcript ever written — 13k+ files,
 * ~5 CPU-s — to find the few touched in the last four hours. The ingest watcher
 * updates `sessions.file_mtime_ms` within seconds of an append, so the index
 * already knows which transcripts are recent; a file it has never seen (a
 * session created since the last reconcile) is still stat'ed.
 *
 * Returns null — stat everything, as before — when the index is off
 * (`MINDER_USE_DB=0`), it isn't known to be current (`readIndexCurrent`:
 * indexer off, this boot's initial reconcile not finished, ingest restarting or
 * paused), or it can't be read.
 */
export async function indexedTranscriptFilter(since: number): Promise<TranscriptStatFilter | null> {
  if (!dbModeRequested() || !(await readIndexCurrent())) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const now = Date.now();
    let known = g.__minderIndexedTranscripts;
    if (!known || now - known.loadedAt > KNOWN_RELOAD_MS) {
      const rows = prepCached(db, "SELECT file_path FROM sessions").all() as Array<{ file_path: string }>;
      known = { paths: new Set(rows.map((r) => r.file_path)), loadedAt: now };
      g.__minderIndexedTranscripts = known;
    }
    const recentRows = prepCached(db, "SELECT file_path FROM sessions WHERE file_mtime_ms > ?").all(
      since
    ) as Array<{ file_path: string }>;
    const recent = new Set(recentRows.map((r) => r.file_path));
    const lookup = prepCached(db, "SELECT 1 FROM sessions WHERE file_path = ?");
    const { paths } = known;
    return {
      mustStat(filePath) {
        if (recent.has(filePath)) return true;
        if (paths.has(filePath)) return false;
        try {
          if (lookup.get(filePath)) {
            paths.add(filePath);
            return false;
          }
        } catch {
          /* unreadable — stat it */
        }
        return true;
      },
    };
  } catch {
    return null;
  }
}

/** Test hook: forget the cached set of indexed paths. */
export function _resetIndexedTranscriptsForTesting(): void {
  delete g.__minderIndexedTranscripts;
}
