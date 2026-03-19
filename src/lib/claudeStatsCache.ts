import { promises as fs } from "fs";
import path from "path";

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
}

interface DiskCache {
  version: 1;
  entries: Record<string, CachedFileStats>; // keyed by filePath
}

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "claude-stats.json");

export async function readDiskCache(): Promise<Map<string, CachedFileStats>> {
  const map = new Map<string, CachedFileStats>();
  try {
    const data = await fs.readFile(CACHE_FILE, "utf-8");
    const parsed: DiskCache = JSON.parse(data);
    if (parsed.version === 1 && parsed.entries) {
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
    version: 1,
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
