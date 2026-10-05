import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { readConfig } from "@/lib/config";
import { withGroups } from "@/lib/groups/withGroups";
import type { ScanResult } from "@/lib/types";

// Cache-first scan for MCP tools. Concurrent callers (5 tool calls firing back-to-back
// before the cache warms) are deduplicated by `scanAllProjects()` itself, which shares
// one in-flight scan per cache generation. This file used to keep its own single-flight
// promise; that one was blind to `invalidateCache()`, so a forced rescan could join a
// scan that began before the invalidation and return pre-invalidation data (#609).

export async function getCachedOrFreshScan(): Promise<ScanResult> {
  return withGroups(await rawScan(), await readConfig());
}

async function rawScan(): Promise<ScanResult> {
  const cached = getCachedScan();
  if (cached) return cached;
  const fresh = await scanAllProjects();
  // Refused (dropped) when an invalidation overtook this scan; we still return it.
  setCachedScan(fresh);
  return fresh;
}
