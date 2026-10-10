/** Top-level orchestrator for an MCP security scan run. */

import "server-only";
import { getUserConfig } from "../../userConfigCache";
import { getCachedOrFreshScan } from "../../mcp/scanHelper";
import { scanAllProjects } from "../index";
import { invalidateCache, setCachedScan } from "../../cache";
import { scanServers } from "./scanner";
import {
  createScanRun,
  updateScanRun,
  saveFindings,
} from "./store";

export interface McpSecurityScanSummary {
  runId: number;
  serversScanned: number;
  findingsCount: number;
  durationMs: number;
}

let runningPromise: Promise<McpSecurityScanSummary> | null = null;

/**
 * Run a full static-surface MCP security scan.
 * Deduplicated: if a scan is already in progress the same promise is returned.
 */
export async function runMcpSecurityScan(
  trigger: "scan" | "manual" | "startup" = "scan",
): Promise<McpSecurityScanSummary> {
  if (runningPromise) return runningPromise;

  runningPromise = (async () => {
    const startMs = Date.now();

    const userConfig = await getUserConfig();
    const servers = userConfig?.mcpServers?.servers ?? [];

    // Project-scope (`.mcp.json`) and local-scope servers are not part of the user config; they come from the
    // project scan (#638).
    // A manual re-run must see an externally edited `.mcp.json`, so it bypasses the cached project scan.
    let scan;
    if (trigger === "manual") {
      // Invalidating first starts a new cache generation, so this does not join a scan already in flight.
      invalidateCache();
      scan = await scanAllProjects();
      setCachedScan(scan);
    } else {
      scan = await getCachedOrFreshScan();
    }
    const projects = scan.projects.filter((p) => (p.mcpServers?.servers.length ?? 0) > 0);
    const projectServerCount = projects.reduce((n, p) => n + (p.mcpServers?.servers.length ?? 0), 0);

    const runId = await createScanRun({
      startedAtMs: startMs,
      durationMs: 0,
      serversScanned: servers.length + projectServerCount,
      findingsCount: 0,
      trigger,
    });

    const findings = scanServers(servers, undefined, runId);
    for (const p of projects) {
      findings.push(...scanServers(p.mcpServers!.servers, p.slug, runId));
    }

    const durationMs = Date.now() - startMs;
    await saveFindings(runId, findings);
    await updateScanRun(runId, durationMs, findings.length);

    return {
      runId,
      serversScanned: servers.length + projectServerCount,
      findingsCount: findings.length,
      durationMs,
    };
  })().finally(() => {
    runningPromise = null;
  });

  return runningPromise;
}
