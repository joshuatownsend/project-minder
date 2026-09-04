import { deriveProjectGroups } from "./derive";
import type { MinderConfig } from "@/lib/types/config";
import type { ScanResult } from "@/lib/types/project";

/**
 * Attach derived groups to a scan result.
 *
 * Every surface that hands a `ScanResult` to a consumer must go through this,
 * or the consumer sees the projects without their grouping: `GET /api/projects`
 * did from P1, but `POST /api/scan` returned the raw result (so a manual rescan
 * silently dropped `groups` from the dashboard until the next load) and the MCP
 * scan helper never exposed them at all. Fixed in P3.
 *
 * Spreads onto a new object rather than mutating the cached `ScanResult` —
 * the cache is shared across requests, and `enqueueProjectCaches` already
 * mutates `p.git` in place; a second in-place mutation would compound that.
 * Grouping is a pure reshape, so recomputing per response is cheap and always
 * reflects the current opt-out list without an extra cache to invalidate.
 *
 * Omits the key entirely when nothing grouped, rather than sending `[]`:
 * `ScanResult.groups` is optional, and the point of never emitting a group of
 * one is that a user with no multi-location repos sees byte-for-byte the
 * response they saw before this feature existed. (Raised by Copilot on #340.)
 */
export function withGroups(result: ScanResult, config: Pick<MinderConfig, "ungroupedPaths">): ScanResult {
  const groups = deriveProjectGroups(result.projects, {
    ungroupedPaths: config.ungroupedPaths,
  });
  return groups.length > 0 ? { ...result, groups } : result;
}
