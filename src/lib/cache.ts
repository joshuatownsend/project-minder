import "server-only";
import { ScanResult } from "./types";
import { emitMinderEvent } from "./events/bus";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Stored on globalThis so the cache survives Next.js HMR module reloads —
// previously each reload reset the cache and forced a full project rescan.
const g = globalThis as unknown as {
  __scanCache?: { result: ScanResult; cachedAt: number };
  /** Bumped by every `invalidateCache()`; `scanAllProjects` only shares an in-flight scan started at the same generation. */
  __scanGeneration?: number;
  /** Generation each `scanAllProjects()` result was started under (see `setCachedScan`). */
  __scanResultGeneration?: WeakMap<ScanResult, number>;
};

export function getCachedScan(): ScanResult | null {
  const cache = g.__scanCache;
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL) {
    return cache.result;
  }
  return null;
}

/** Returns whether the result was stored. `false` means it was refused as stale, so a caller
 *  that goes on to act on the result (warm caches from it) must not. */
export function setCachedScan(result: ScanResult): boolean {
  // A scan that began before an `invalidateCache()` must not publish: it can finish
  // AFTER the post-invalidation scan and would put pre-invalidation data back for the
  // whole TTL, undoing the invalidation. Results are tagged with the generation they
  // started under by `scanAllProjects`; anything untagged (a hand-built result) publishes as before.
  const startedAt = g.__scanResultGeneration?.get(result);
  if (startedAt !== undefined && startedAt !== (g.__scanGeneration ?? 0)) return false;
  g.__scanCache = { result, cachedAt: Date.now() };
  return true;
}

export function invalidateCache(): void {
  g.__scanCache = undefined;
  g.__scanGeneration = (g.__scanGeneration ?? 0) + 1;
  // Signal connected SSE clients that scan-derived data changed so they can
  // invalidate the matching queries (no-op when no client is listening).
  emitMinderEvent("scan.invalidated");
}
