import {
  parseAllSessions,
  getJsonlMaxMtime,
  getJsonlFileCount,
} from "@/lib/usage/parser";
import { classifyTurn } from "@/lib/usage/classifier";

// Top-level histogram of session turn categories (Feature Dev / Refactoring /
// etc.), memoized by a corpus fingerprint -- (newest JSONL mtime, file count)
// -- so a /memory/seed reload that follows a /usage hit reuses the same
// classification pass. The count is the half that sees a DELETION; see #492 at
// the key itself for why a watermark alone cannot. The aggregator
// in src/lib/usage/aggregator.ts does much more (cost calc, MCP parsing,
// shell parsing) -- this helper exists for callers that just want the
// histogram. Module-scope cache so HMR survives.

const g = globalThis as unknown as {
  __seedCategoryCounts?: {
    mtime: number;
    fileCount: number;
    map: Map<string, number>;
  };
};

/**
 * Drop the memoized histogram.
 *
 * Needed because the memo key is a corpus fingerprint with no TTL, and enabling
 * an adapter changes the corpus without necessarily moving either half of it —
 * a newly enabled adapter whose transcripts are all older than the newest Claude
 * one leaves the watermark untouched, and the file count moves only once a sweep
 * has actually read them. So `/api/memory/seed` would serve the previous corpus
 * indefinitely rather than for a bounded window. The sibling caches self-heal on
 * a 5-minute TTL; this one does not, which is what makes it the only other site
 * needing this. (Codex P2, PR #490.)
 *
 * Still needed after #492 added the file count. That closed DELETION, which the
 * config PATCH cannot see; this closes an ENABLE, which the fingerprint cannot.
 * Neither subsumes the other.
 */
export function invalidateSessionCategoryCounts(): void {
  g.__seedCategoryCounts = undefined;
}

export async function getSessionCategoryCounts(): Promise<Map<string, number>> {
  const sessions = await parseAllSessions();
  // Fingerprint the corpus on (newest mtime, file count), not mtime alone.
  //
  // A max-mtime watermark is MONOTONE: it answers "has anything newer
  // appeared" and nothing else, so deleting a transcript that does not hold
  // the maximum leaves it untouched and the histogram below survives a corpus
  // it no longer describes — indefinitely, because there is no TTL here the
  // way there is on the sibling per-project caches. Cardinality is the
  // dimension that deletion actually moves. (#492)
  const mtime = getJsonlMaxMtime();
  const fileCount = getJsonlFileCount();
  const cached = g.__seedCategoryCounts;
  if (cached && cached.mtime === mtime && cached.fileCount === fileCount) {
    return cached.map;
  }

  const map = new Map<string, number>();
  for (const turns of sessions.values()) {
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const cat = classifyTurn(turn);
      map.set(cat, (map.get(cat) ?? 0) + 1);
    }
  }
  g.__seedCategoryCounts = { mtime, fileCount, map };
  return map;
}
