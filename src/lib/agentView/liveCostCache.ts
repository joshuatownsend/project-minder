import "server-only";
import { promises as fs } from "fs";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { parseSessionTurns } from "@/lib/usage/parser";
import type { IndexedTurnTokens } from "@/lib/data/indexedLiveMetrics";
import {
  loadPricing,
  getModelPricing,
  applyPricing,
  getModelMaxContextTokens,
} from "@/lib/usage/costCalculator";

export interface SessionMetrics {
  totalCostUsd: number;
  /** Context fill ratio [0,1] for the most recent assistant turn (not historical peak). */
  contextFill: number;
}

// Per-session mtime-keyed cache for the PARSE fallback only. Avoids
// re-reducing the same turns on every SSE delta — `parseSessionTurns` handles
// the raw-parse cache; this layer caches the reduced numbers on top. The index
// path needs no cache: it is two indexed lookups. Stored on globalThis to
// survive HMR; `pruneLiveMetricsCache` drops sessions that left the board.
const g = globalThis as unknown as {
  __liveMetricsCache?: Map<string, { mtime: number; result: SessionMetrics }>;
};

function getCache(): Map<string, { mtime: number; result: SessionMetrics }> {
  if (!g.__liveMetricsCache) g.__liveMetricsCache = new Map();
  return g.__liveMetricsCache;
}

/** Context fill of one assistant turn: everything the model read, over its window. */
function turnFill(turn: IndexedTurnTokens): number {
  return (
    (turn.inputTokens + turn.cacheCreateTokens + turn.cacheReadTokens) /
    getModelMaxContextTokens(turn.model)
  );
}

/**
 * Compute cost and current context-fill ratio for a live (non-terminal) session.
 *
 * Reads the index when it has the session (#657): the ingest worker has
 * already parsed and priced every turn, so re-parsing the whole transcript here
 * on every update was the main thread repeating the worker's work. Falls back
 * to parsing the transcript when the index is off or has no row yet.
 *
 * Returns null if the session file cannot be found or read.
 */
export async function getLiveSessionMetrics(
  sessionId: string,
): Promise<SessionMetrics | null> {
  // DYNAMIC for the same reason as `indexedSessionPath` below.
  const { indexedLiveMetrics } = await import("@/lib/data/indexedLiveMetrics");
  const indexed = await indexedLiveMetrics(sessionId);
  if (indexed) {
    return {
      totalCostUsd: indexed.costUsd,
      contextFill: indexed.lastAssistant ? turnFill(indexed.lastAssistant) : 0,
    };
  }

  // DYNAMIC, and it has to be. `indexedSessionPath` reaches `db/connection`,
  // which freezes the `~/.minder` path constant at module-evaluation time — so
  // a STATIC import here would put it on the graph of every test that imports
  // this module, before any of them can install an isolated home.
  // `tests/dbIsolationGuard` enforces that, and caught this import when it was
  // static. Same reason `data/index.ts` lazy-loads its own DB modules.
  const { indexedSessionPath } = await import("@/lib/data/indexedSessionPath");
  const resolved = await resolveSessionJsonl(sessionId, { indexedPath: indexedSessionPath });
  if (!resolved) return null;
  const { filePath, projectDirName } = resolved;

  let mtime: number;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
  } catch {
    return null;
  }

  const cache = getCache();
  const cached = cache.get(sessionId);
  if (cached && cached.mtime === mtime) return cached.result;

  await loadPricing();
  let turns: Awaited<ReturnType<typeof parseSessionTurns>>;
  try {
    turns = await parseSessionTurns(filePath, projectDirName);
  } catch {
    return null;
  }

  let totalCostUsd = 0;
  let contextFill = 0;

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const pricing = getModelPricing(turn.model, turn.speed);
    totalCostUsd += applyPricing(pricing, turn);
    // Use the most recent turn's fill, not the historical peak. Turns are
    // chronological so the last write wins — after a /compact the chip
    // reflects the compacted context rather than the pre-compact high-water mark.
    contextFill = turnFill(turn);
  }

  const result: SessionMetrics = { totalCostUsd, contextFill };
  cache.set(sessionId, { mtime, result });
  return result;
}

/**
 * Drop cached parse results for sessions no longer on the board, so a
 * long-running server does not keep one entry per session it ever showed.
 */
export function pruneLiveMetricsCache(keep: ReadonlySet<string>): void {
  const cache = g.__liveMetricsCache;
  if (!cache) return;
  for (const sessionId of cache.keys()) {
    if (!keep.has(sessionId)) cache.delete(sessionId);
  }
}

/** Reset module state — for testing only. */
export function _resetLiveMetricsCacheForTesting(): void {
  delete g.__liveMetricsCache;
}
