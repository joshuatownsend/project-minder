import { ScanResult } from "./types";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let cachedResult: ScanResult | null = null;
let cachedAt: number = 0;

export function getCachedScan(): ScanResult | null {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL) {
    return cachedResult;
  }
  return null;
}

export function setCachedScan(result: ScanResult): void {
  cachedResult = result;
  cachedAt = Date.now();
}

export function invalidateCache(): void {
  cachedResult = null;
  cachedAt = 0;
}
