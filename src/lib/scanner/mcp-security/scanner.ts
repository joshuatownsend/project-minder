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
const SHELL_SCRIPT_RULES: ReadonlySet<string> = new Set(["SF-01", "SF-02", "SF-03", "SF-09", "CI-01", "CI-02"]);
const POWERSHELL_RULES: ReadonlySet<string> = new Set(["SF-08"]);
const CMD_RULES: ReadonlySet<string> = new Set(["SF-09"]);
const LAUNCH_LINE_RULES: ReadonlySet<string> = new Set([...SHELL_SCRIPT_RULES, ...POWERSHELL_RULES, ...CMD_RULES]);
const DIRECT_RULES: ReadonlySet<string> = new Set(["SF-01", "SF-09"]);
const DIRECT_DESTRUCTIVE = new Set(["rm", "del", "erase", "rd", "rmdir"]);

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
    if (a === "-o" || a === "+o" || a === "-O" || a === "+O" || a === "--rcfile" || a === "--init-file") {
      i++; // takes an option name or a file
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return args[i + 1] ?? null;
    if (a === "--command") return args[i + 1] ?? null; // fish
    if (a.startsWith("--command=")) return a.slice("--command=".length);
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

    const perSurface: McpFinding[] = [];
    for (const entry of surfaces) {
      perSurface.push(...scanSurface(entry.text, entry.surface, sId, scope, projectSlug, runId, nowMs));
    }
    const own: McpFinding[] = []; // findings from the launch-line passes below

    // The stdio probe spawns the command with argv, so a destructive payload hides in the script argument of
    // a shell wrapper (`sh -c "..."`), where the delimiter-based rules cannot see it (#634).
    const script = shellScript(server);
    if (script !== null) {
      // Statements are separated by newlines as well as `;`, and the rules expect a delimiter in front.
      const text = ";" + script.replace(/\r?\n/g, ";");
      own.push(...scanSurface(text, "args", sId, scope, projectSlug, runId, nowMs, SHELL_SCRIPT_RULES));
    }
    if (server.command) {
      const base = baseName(server.command).toLowerCase();
      const line = [server.command, ...(server.args ?? [])].join(" ");
      // On Windows the probe goes through cmd.exe, which interprets the whole joined line, so the shell and
      // PowerShell rules run over it (command/args boundaries do not matter there). PowerShell's rule also
      // names the executable, which is why it needs the line rather than the arguments.
      own.push(...scanSurface(line, "command", sId, scope, projectSlug, runId, nowMs, LAUNCH_LINE_RULES));
      // `cmd /c <command>`: the first command after the switch has no delimiter in front of it.
      if (base === "cmd") {
        const args = server.args ?? [];
        const at = args.findIndex((a) => /^\/[ck]$/i.test(a));
        if (at >= 0) {
          const rest = ";" + args.slice(at + 1).join(" ");
          own.push(...scanSurface(rest, "args", sId, scope, projectSlug, runId, nowMs, LAUNCH_LINE_RULES));
        }
      }
      // A destructive program launched directly (`rm` with `-rf /`) has no shell wrapper to hide in. GNU rm
      // takes options in any order and in long form, so recursion is judged from the arguments, not the text.
      if (DIRECT_DESTRUCTIVE.has(base)) {
        const recursive = (server.args ?? []).some((a) => a === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a));
        const text = base === "rm" && recursive ? ";rm -rf " + line : ";" + line;
        own.push(...scanSurface(text, "command", sId, scope, projectSlug, runId, nowMs, DIRECT_RULES));
      }
    }

    // The launch-line passes overlap the per-surface ones; a rule already reported for this server is not repeated.
    findings.push(...perSurface);
    const seen = new Set(perSurface.map((f) => f.ruleId));
    for (const f of own) {
      if (seen.has(f.ruleId)) continue;
      seen.add(f.ruleId);
      findings.push(f);
    }
  }

  return findings;
}
