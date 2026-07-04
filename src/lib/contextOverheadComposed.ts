import "server-only";
import { getDb, prepCached } from "@/lib/db/connection";
import { getUserConfig } from "@/lib/userConfigCache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { readUserClaudeMdContent } from "@/lib/scanner/userClaudeMd";
import {
  computeContextOverhead,
  type ContextOverheadBreakdown,
} from "@/lib/contextOverhead";

// Shared between the /api/context-overhead route handler and the MCP
// `get-context-overhead` tool. Each input has its own cache (userConfig 5min,
// loadCatalog 5min, readUserClaudeMd mtime-keyed, prepCached reuses the
// statement) — no extra caching needed at this layer.

const RECENT_SESSION_SAMPLE_SIZE = 30;

export async function gatherContextOverhead(): Promise<ContextOverheadBreakdown> {
  const [userConfig, catalog, userMemoryContent, observedSamples] = await Promise.all([
    getUserConfig(),
    loadCatalog({ includeProjects: false }),
    readUserClaudeMdContent(),
    loadObservedSamples().catch(() => [] as number[]),
  ]);

  return computeContextOverhead({
    mcpServerCount: userConfig.mcpServers.servers.length,
    skills: catalog.skills,
    hookEntries: userConfig.hooks.entries,
    memoryBytes: Buffer.byteLength(userMemoryContent, "utf-8"),
    observedSamples,
  });
}

// Two-stage query: pick the most-recent N completed sessions by their index,
// then per-session find the first non-zero cache_create_tokens assistant turn.
// The `> 0` filter excludes synthetic turns and tail-rebuild fallbacks — if
// they were included, the median would drag toward zero and undercount real
// startup overhead.
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
         AND t.is_sidechain = 0
         AND t.cache_create_tokens > 0
       ORDER BY t.turn_index ASC
       LIMIT 1
     ) AS startup_tokens
     FROM recent r`
  ).all(RECENT_SESSION_SAMPLE_SIZE) as Array<{ startup_tokens: number | null }>;

  return rows
    .map((r) => r.startup_tokens)
    .filter((n): n is number => typeof n === "number" && n > 0);
}
