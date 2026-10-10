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

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "csh", "tcsh", "fish"]);
const POWERSHELL = /^(?:powershell|pwsh)$/i;
// Delimiter-based rules re-run over the extracted script text.
const SHELL_SCRIPT_RULES: ReadonlySet<string> = new Set(["SF-01", "SF-02", "SF-03", "CI-01", "CI-02"]);
const POWERSHELL_RULES: ReadonlySet<string> = new Set(["SF-08"]);

function baseName(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command;
  return leaf.replace(/\.exe$/i, "");
}

/**
 * The script a POSIX shell is asked to run, i.e. the argument after the `-c` option (alone or inside a
 * short-option group such as `-lc` / `-cl`, after any other options). Later arguments are `$0`, `$1`, …
 * and are not executed. Null for anything that is not a shell `-c` launch.
 */
export function shellScript(server: McpServer): string | null {
  if (!server.command || !SHELLS.has(baseName(server.command).toLowerCase())) return null;
  const args = server.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || !/^[-+]/.test(a)) return null; // first operand reached without a -c
    if (a === "-o" || a === "+o" || a === "-O" || a === "+O") {
      i++; // takes an option name
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return args[i + 1] ?? null;
  }
  return null;
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
  only?: ReadonlySet<string>,
): McpFinding[] {
  const findings: McpFinding[] = [];
  const deobbed = deobfuscate(text);
  const deobbedLeet = deobfuscate(text, true);

  for (const rule of PATTERN_RULES) {
    if (only && !only.has(rule.id)) continue;
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

    // The stdio probe spawns the command with argv, no shell, so a destructive payload hides in the script
    // argument of a shell wrapper (`sh -c "..."`), where the delimiter-based rules cannot see it (#634).
    const script = shellScript(server);
    if (script !== null) {
      // Statements are separated by newlines as well as `;`, and the rules expect a delimiter in front.
      const text = ";" + script.replace(/\r?\n/g, ";");
      findings.push(...scanSurface(text, "args", sId, scope, projectSlug, runId, nowMs, SHELL_SCRIPT_RULES));
    }
    // PowerShell flags are matched against the launch line, since its rule names the executable too.
    if (server.command && server.args?.length && POWERSHELL.test(baseName(server.command))) {
      const line = [server.command, ...server.args].join(" ");
      findings.push(...scanSurface(line, "command", sId, scope, projectSlug, runId, nowMs, POWERSHELL_RULES));
    }
  }

  return findings;
}
