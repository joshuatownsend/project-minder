import { promises as fs } from "fs";
import path from "path";
import os from "os";

const CACHE_FILE = path.join(os.homedir(), ".minder", "exchange-rates.json");
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?base=USD";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let ratesMap: Record<string, number> | null = null;
let fetchedAt: string | null = null;
let loadPromise: Promise<void> | null = null;

interface FrankfurterResponse {
  base: string;
  date: string;
  rates: Record<string, number>;
}

interface CacheEntry {
  fetchedAt: string;
  rates: Record<string, number>;
}

export async function loadFxRates(): Promise<void> {
  if (ratesMap) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      let useDiskCache = false;
      try {
        const stat = await fs.stat(CACHE_FILE);
        useDiskCache = Date.now() - stat.mtimeMs < CACHE_TTL_MS;
      } catch { /* no cache */ }

      if (useDiskCache) {
        const raw = await fs.readFile(CACHE_FILE, "utf-8");
        const entry = JSON.parse(raw) as CacheEntry;
        ratesMap = entry.rates;
        fetchedAt = entry.fetchedAt;
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(FRANKFURTER_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
        const body = (await res.json()) as FrankfurterResponse;
        ratesMap = body.rates;
        fetchedAt = new Date().toISOString();

        try {
          await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
          const entry: CacheEntry = { fetchedAt: fetchedAt!, rates: ratesMap };
          await fs.writeFile(CACHE_FILE, JSON.stringify(entry), "utf-8");
        } catch { /* non-critical */ }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      if (!ratesMap) ratesMap = {};
    }
  })();

  return loadPromise;
}

/**
 * FX rate for converting 1 USD to `currency`. Returns 1 for USD.
 * Triggers a disk/network load on first call.
 */
export async function getRate(currency: string): Promise<number> {
  if (currency === "USD") return 1;
  if (!ratesMap) await loadFxRates();
  return (ratesMap ?? {})[currency] ?? 1;
}

/** Synchronous read of the in-memory rates cache. Returns {} until warmed. */
export function getRatesSync(): Record<string, number> {
  return ratesMap ?? {};
}

/** ISO timestamp of when the cache was last populated. */
export function getFetchedAt(): string | null {
  return fetchedAt;
}

/** For testing only. */
export function _resetForTesting(): void {
  ratesMap = null;
  fetchedAt = null;
  loadPromise = null;
}
