import { ScanResult } from "./types";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Stored on globalThis so the cache survives Next.js HMR module reloads —
// previously each reload reset the cache and forced a full project rescan.
const g = globalThis as unknown as {
  __scanCache?: { result: ScanResult; cachedAt: number };
};

export function getCachedScan(): ScanResult | null {
  const cache = g.__scanCache;
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL) {
    return cache.result;
  }
  return null;
}

export function setCachedScan(result: ScanResult): void {
  g.__scanCache = { result, cachedAt: Date.now() };
}

export function invalidateCache(): void {
  g.__scanCache = undefined;
}
