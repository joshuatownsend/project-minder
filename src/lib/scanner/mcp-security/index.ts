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
 * Deduplicated: if a scan is already in progress an automatic trigger gets the same promise; a manual one
 * waits for it and starts its own.
 */
export async function runMcpSecurityScan(
  trigger: "scan" | "manual" | "startup" = "scan",
): Promise<McpSecurityScanSummary> {
  // An automatic trigger may share a run already in progress. A manual re-run may not: that run could have
  // read the project scan before an edit the user is now asking to see, so it waits and then runs afresh.
  while (runningPromise) {
    if (trigger !== "manual") return runningPromise;
    await runningPromise.catch(() => undefined);
  }

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
