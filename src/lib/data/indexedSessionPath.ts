import "server-only";
import { getDb } from "@/lib/db/connection";

/**
 * The transcript path the index recorded for a session (#486).
 *
 * `resolveSessionJsonl` finds a transcript by WALKING every readable Claude
 * home. The flat pass is cheap; the nested-subagent pass is not — measured at
 * 80 project directories, 3,279 session subdirectories and ~1.4 s for a single
 * miss — and several per-session endpoints call the resolver independently, so
 * a handful of requests for one bad `agent-*` id multiply it.
 *
 * The index already stores `sessions.file_path`. Where it is available the
 * answer is one lookup, no walk, and — because it is the path the file was
 * actually read from — it carries the real layout, so nothing downstream has to
 * re-derive whether the transcript is flat or nested.
 *
 * ## Why this lives here and not in the resolver
 *
 * `src/lib/usage/` is the file backend's foundation and deliberately has no DB
 * dependency. Giving the resolver its own DB fast path would invert that — the
 * module the no-database configuration is built on would import the database.
 * So the resolver takes a lookup, and this supplies one; routes that already
 * sit above the data layer pass it in.
 *
 * ## Never fatal
 *
 * Returns `null` for every failure — no DB, no row, an unreadable index. The
 * caller then walks, which is exactly what it did before this existed. A hint
 * that cannot be produced must not turn a working lookup into an error.
 */
export async function indexedSessionPath(sessionId: string): Promise<string | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const row = db
      .prepare("SELECT file_path FROM sessions WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { file_path?: string } | undefined;
    return row?.file_path ?? null;
  } catch {
    return null;
  }
}
