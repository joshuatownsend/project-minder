/**
 * Static-surface MCP security scanner.
 *
 * Runs the deobfuscation pipeline + pattern rules over the static metadata
 * (command, args, url, env key names, server name) of every McpServer.
 * No subprocess execution — pure string analysis over data already in memory.
 */

import type { McpServer } from "../../types";
import type { McpFinding, McpFindingCategory, McpFindingSurface, McpScanRun } from "../../types";
import { deobfuscate } from "./deobfuscate";
import { PATTERN_RULES, LEETSPEAK_CATEGORIES } from "./patterns";
import { buildServerId } from "./ids";

// DE rules detect evasion techniques — they must run on the original text before deobfuscation.
const DE_CATEGORIES = new Set<McpFindingCategory>(["DE"]);
// CH/EP matches may contain actual credentials — store evidence as undefined rather than writing secrets to disk.
const REDACT_EVIDENCE_CATEGORIES = new Set<McpFindingCategory>(["CH", "EP"]);

const MAX_EVIDENCE_CHARS = 120;

function truncateEvidence(match: string): string {
  return match.length > MAX_EVIDENCE_CHARS ? match.slice(0, MAX_EVIDENCE_CHARS) + "…" : match;
}

function serverId(server: McpServer, projectSlug?: string): string {
  return buildServerId(server.source, server.name, projectSlug);
}

function dbScope(server: McpServer): "user" | "project" {
  return server.source === "project" ? "project" : "user";
}

interface SurfaceEntry {
  surface: McpFindingSurface;
  text: string;
}

function buildSurfaces(server: McpServer): SurfaceEntry[] {
  const entries: SurfaceEntry[] = [];
  if (server.name) entries.push({ surface: "name", text: server.name });
  if (server.command) entries.push({ surface: "command", text: server.command });
  if (server.args?.length) entries.push({ surface: "args", text: server.args.join(" ") });
  if (server.url) entries.push({ surface: "url", text: server.url });
  if (server.envKeys?.length) entries.push({ surface: "env", text: server.envKeys.join(" ") });
  return entries;
}

function scanSurface(
  text: string,
  surface: SurfaceEntry["surface"],
  servId: string,
  scope: "user" | "project",
  projectSlug: string | undefined,
  runId: number,
  nowMs: number,
): McpFinding[] {
  const findings: McpFinding[] = [];
  const deobbed = deobfuscate(text);
  const deobbedLeet = deobfuscate(text, true);

  for (const rule of PATTERN_RULES) {
    const target = DE_CATEGORIES.has(rule.category)
      ? text
      : LEETSPEAK_CATEGORIES.has(rule.category) ? deobbedLeet : deobbed;

    const match = target.match(rule.regex);
    if (!match) continue;

    findings.push({
      runId,
      serverId: servId,
      scope,
      projectSlug,
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      surface,
      message: rule.message,
      evidence: REDACT_EVIDENCE_CATEGORIES.has(rule.category)
        ? undefined
        : truncateEvidence(match[0]),
      foundAtMs: nowMs,
    });
  }

  return findings;
}

export interface ScanResult {
  findings: McpFinding[];
  runMeta: Omit<McpScanRun, "id">;
}

/**
 * Scan a list of McpServer objects for security issues.
 *
 * @param servers  The merged list from userConfigCache + per-project scan.
 * @param projectSlug  Set when scanning project-scope servers; undefined otherwise.
 * @param runId    The mcp_scan_runs.id for this batch (caller creates the run row first).
 */
export function scanServers(
  servers: McpServer[],
  projectSlug: string | undefined,
  runId: number,
): McpFinding[] {
  const nowMs = Date.now();
  const findings: McpFinding[] = [];

  for (const server of servers) {
    const sId = serverId(server, projectSlug);
    const scope = dbScope(server);
    const surfaces = buildSurfaces(server);

    for (const entry of surfaces) {
      findings.push(...scanSurface(entry.text, entry.surface, sId, scope, projectSlug, runId, nowMs));
    }
  }

  return findings;
}
