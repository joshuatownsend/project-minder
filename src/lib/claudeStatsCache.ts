import { promises as fs } from "fs";
import path from "path";
import { resolveStateDir } from "./serverRoot";

/**
 * One priced token bucket. Field names are the one-letter forms the scanner
 * already uses internally (`i`nput, `o`utput, `c`ache `c`reate, cache create at
 * the `1h` TTL, `c`ache `r`ead) — this is a machine-only file written once per
 * scan and read once per scan, and the long names would roughly double it.
 */
export interface CachedTokenBucket {
  i: number;
  o: number;
  cc: number;
  cc1h: number;
  cr: number;
}

/**
 * Token buckets for one model within one transcript, split along every
 * dimension that changes the RATE rather than the count.
 *
 * Buckets are omitted when empty, which is the common case: an ordinary
 * transcript has `base` only. Keeping the file sparse matters — it holds one
 * entry per transcript across every project.
 */
export interface CachedModelBuckets {
  base?: CachedTokenBucket;
  /** Turns whose own prompt exceeded 200k, billed at the above-200k rates. */
  long?: CachedTokenBucket;
  /** `usage.speed === "fast"` turns, billed at the premium fast-mode rates. */
  fast?: CachedTokenBucket;
}

export interface CachedFileStats {
  filePath: string;
  mtime: number;
  size: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  turns: number;
  tools: Record<string, number>;
  errors: number;
  models: string[];
  /**
   * Per-model, per-rate token split — everything pricing needs that the flat
   * totals above cannot express (#394).
   *
   * Before this existed, a cache hit re-priced from the flat totals alone, and
   * the recomputed cost lost three things at once: the model (every token was
   * attributed to an `unknown` bucket priced at Sonnet rates, so an Opus-heavy
   * transcript came back ~40% cheap), the long-context tier (all base), and the
   * 1-hour cache-write TTL (all 5-minute, ~37% light on cache writes). The
   * displayed cost therefore *changed after the first scan and stayed low*,
   * which is worse than a consistently wrong number because it defeats
   * comparison against yesterday's screenshot or export.
   *
   * Optional only for the type to stay honest about entries read from disk;
   * every entry this version writes carries it.
   */
  perModel?: Record<string, CachedModelBuckets>;
}

/**
 * Bumped 1 → 2 when `perModel` was added (#394).
 *
 * `readDiskCache` discards any other version outright rather than migrating.
 * That is the whole healing mechanism and it is deliberate: this file is a
 * derived index over transcripts that are still sitting on disk, so the cost of
 * throwing it away is one slower scan, and the cost of migrating it is
 * inventing a per-model split that was never recorded. A wrong number that
 * looks precise is worse than a rescan.
 */
const CACHE_VERSION = 2;

interface DiskCache {
  version: number;
  entries: Record<string, CachedFileStats>; // keyed by filePath
}

const CACHE_DIR = path.join(resolveStateDir(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "claude-stats.json");

export async function readDiskCache(): Promise<Map<string, CachedFileStats>> {
  const map = new Map<string, CachedFileStats>();
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    const parsed: DiskCache = JSON.parse(data);
    if (parsed.version === CACHE_VERSION && parsed.entries) {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        map.set(key, entry);
      }
    }
  } catch {
    // Cache doesn't exist or is corrupt — start fresh
  }
  return map;
}

export async function writeDiskCache(
  entries: Map<string, CachedFileStats>
): Promise<void> {
  const cache: DiskCache = {
    version: CACHE_VERSION,
    entries: Object.fromEntries(entries),
  };
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch {
    // Non-critical — cache write failure doesn't break anything
  }
}

/**
 * Check if a cached entry is still valid for a file.
 * Returns true if mtime and size match (file hasn't changed).
 */
export function isCacheHit(
  cached: CachedFileStats | undefined,
  mtime: number,
  size: number
): boolean {
  if (!cached) return false;
  return cached.mtime === mtime && cached.size === size;
}
