import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { classifyTurn } from "@/lib/usage/classifier";

// Top-level histogram of session turn categories (Feature Dev / Refactoring /
// etc.), memoized by the max JSONL mtime so a /memory/seed reload that
// follows a /usage hit reuses the same classification pass. The aggregator
// in src/lib/usage/aggregator.ts does much more (cost calc, MCP parsing,
// shell parsing) -- this helper exists for callers that just want the
// histogram. Module-scope cache so HMR survives.

const g = globalThis as unknown as {
  __seedCategoryCounts?: { mtime: number; map: Map<string, number> };
};

/**
 * Drop the memoized histogram.
 *
 * Needed because the memo key is `getJsonlMaxMtime()` equality with no TTL, and
 * enabling an adapter changes the corpus WITHOUT necessarily moving that
 * watermark — a newly enabled adapter whose transcripts are all older than the
 * newest Claude one leaves it untouched, so `/api/memory/seed` would serve the
 * previous corpus indefinitely rather than for a bounded window. The sibling
 * caches self-heal on a 5-minute TTL; this one does not, which is what makes it
 * the only other site needing this. (Codex P2, PR #490.)
 */
export function invalidateSessionCategoryCounts(): void {
  g.__seedCategoryCounts = undefined;
}

export async function getSessionCategoryCounts(): Promise<Map<string, number>> {
  const sessions = await parseAllSessions();
  const mtime = getJsonlMaxMtime();
  const cached = g.__seedCategoryCounts;
  if (cached && cached.mtime === mtime) return cached.map;

  const map = new Map<string, number>();
  for (const turns of sessions.values()) {
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const cat = classifyTurn(turn);
      map.set(cat, (map.get(cat) ?? 0) + 1);
    }
  }
  g.__seedCategoryCounts = { mtime, map };
  return map;
}
