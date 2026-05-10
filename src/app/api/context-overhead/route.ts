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
 * The `> 0` filter skips synthetic turns and tail-rebuild fallbacks (which
 * write zero `cache_create_tokens` to the same row) — including them would
 * drag the median toward zero and undercount real startup overhead.
 */
async function loadObservedSamples(): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = prepCached(
    db,
    `WITH first_asst AS (
       SELECT session_id, MIN(turn_index) AS first_idx
       FROM turns
       WHERE role = 'assistant' AND cache_create_tokens > 0
       GROUP BY session_id
     )
     SELECT t.cache_create_tokens AS startup_tokens
     FROM turns t
     JOIN first_asst fa
       ON t.session_id = fa.session_id AND t.turn_index = fa.first_idx
     JOIN sessions s ON s.session_id = t.session_id
     WHERE s.end_ts IS NOT NULL
     ORDER BY s.end_ts DESC
     LIMIT ?`,
  ).all(RECENT_SESSION_SAMPLE_SIZE) as Array<{ startup_tokens: number }>;

  return rows.map((r) => r.startup_tokens);
}
