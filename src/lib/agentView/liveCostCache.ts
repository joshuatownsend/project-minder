import "server-only";
import { promises as fs } from "fs";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { parseSessionTurns } from "@/lib/usage/parser";
import {
  loadPricing,
  getModelPricing,
  applyPricing,
  getModelMaxContextTokens,
} from "@/lib/usage/costCalculator";

export interface SessionMetrics {
  totalCostUsd: number;
  maxContextFill: number;
}

// Per-session mtime-keyed cache. Avoids re-reducing the same turns on every
// SSE delta — `parseSessionTurns` handles the raw-parse cache; this layer
// caches the reduced numbers on top. Stored on globalThis to survive HMR.
const g = globalThis as unknown as {
  __liveMetricsCache?: Map<string, { mtime: number; result: SessionMetrics }>;
};

function getCache(): Map<string, { mtime: number; result: SessionMetrics }> {
  if (!g.__liveMetricsCache) g.__liveMetricsCache = new Map();
  return g.__liveMetricsCache;
}

/**
 * Compute cost and peak context-fill ratio for a live (non-terminal) session.
 * Returns null if the session file cannot be found or read.
 */
export async function getLiveSessionMetrics(
  sessionId: string,
): Promise<SessionMetrics | null> {
  const resolved = await resolveSessionJsonl(sessionId);
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
  let maxContextFill = 0;

  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const pricing = getModelPricing(turn.model);
    totalCostUsd += applyPricing(pricing, turn);
    const maxCtx = getModelMaxContextTokens(turn.model);
    // Use the most recent turn's fill, not the historical peak. Turns are
    // chronological so the last write wins — after a /compact the chip
    // reflects the compacted context rather than the pre-compact high-water mark.
    maxContextFill = (turn.inputTokens + turn.cacheCreateTokens + turn.cacheReadTokens) / maxCtx;
  }

  const result: SessionMetrics = { totalCostUsd, maxContextFill };
  cache.set(sessionId, { mtime, result });
  return result;
}

/** Reset module state — for testing only. */
export function _resetLiveMetricsCacheForTesting(): void {
  delete g.__liveMetricsCache;
}
