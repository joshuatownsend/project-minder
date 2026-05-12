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
