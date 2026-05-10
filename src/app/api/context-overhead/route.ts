import "server-only";
import { NextResponse } from "next/server";
import { getDb, prepCached } from "@/lib/db/connection";
import { getUserConfig } from "@/lib/userConfigCache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { readUserClaudeMdContent } from "@/lib/scanner/userClaudeMd";
import { computeContextOverhead } from "@/lib/contextOverhead";

/**
 * `/api/context-overhead` — portfolio-wide context-overhead estimate
 * (TODO #135 / Phase 3). Mounted by `ContextOverheadPanel` on `/stats`.
 *
 * Composes four pre-existing readers and one SQL probe. Every upstream
 * input has its own cache (userConfigCache 5min, loadCatalog 5min,
 * readUserClaudeMd mtime-keyed, `prepCached` reuses the prepared
 * statement) — no extra caching here.
 */

const RECENT_SESSION_SAMPLE_SIZE = 30;

export async function GET() {
  const [userConfig, catalog, userMemoryContent, observedSamples] =
    await Promise.all([
      getUserConfig(),
      loadCatalog({ includeProjects: false }),
      readUserClaudeMdContent(),
      loadObservedSamples().catch(() => [] as number[]),
    ]);

  const breakdown = computeContextOverhead({
    mcpServerCount: userConfig.mcpServers.servers.length,
    skills: catalog.skills,
    hookEntries: userConfig.hooks.entries,
    memoryBytes: Buffer.byteLength(userMemoryContent, "utf-8"),
    observedSamples,
  });

  return NextResponse.json(breakdown, {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Two-stage query so the per-turn scan is bounded to the N most-recent
 * sessions instead of grouping over the full `turns` table:
 *   1. `recent` picks the LIMIT-N most-recent completed session_ids
 *      (uses the `sessions(end_ts DESC)` index).
 *   2. The outer SELECT joins a correlated subquery per session that
 *      finds its first non-zero-cache-create assistant turn.
 *
 * The `> 0` filter on `cache_create_tokens` skips synthetic turns and
 * tail-rebuild fallbacks — including them would drag the median toward
 * zero and undercount real startup overhead.
 */
async function loadObservedSamples(): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = prepCached(
    db,
    `WITH recent AS (
       SELECT session_id
       FROM sessions
       WHERE end_ts IS NOT NULL
       ORDER BY end_ts DESC
       LIMIT ?
     )
     SELECT (
       SELECT t.cache_create_tokens
       FROM turns t
       WHERE t.session_id = r.session_id
         AND t.role = 'assistant'
         AND t.cache_create_tokens > 0
       ORDER BY t.turn_index ASC
       LIMIT 1
     ) AS startup_tokens
     FROM recent r`,
  ).all(RECENT_SESSION_SAMPLE_SIZE) as Array<{ startup_tokens: number | null }>;

  return rows
    .map((r) => r.startup_tokens)
    .filter((n): n is number => typeof n === "number" && n > 0);
}
