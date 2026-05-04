import type { UsageTurn } from "@/lib/usage/types";
import type { McpServer } from "@/lib/types";
import type { AgentEntry, SkillEntry } from "@/lib/indexer/types";

// Multi-factor waste optimizer. Pure module: run on-demand against
// already-loaded turns + project MCP set + indexer catalog. Five
// detectors, each emitting at most one finding with severity (drives
// the A–F roll-up), estimated tokens saveable, and a copy-paste fix.
// The API route handles I/O; this module is a deterministic transform.

export type WasteSeverity = "high" | "medium" | "low";

export type WasteCode =
  | "junk-reads"
  | "duplicate-reads"
  | "unused-mcp-servers"
  | "ghost-capabilities"
  | "low-read-edit-ratio";

export interface WasteFinding {
  code: WasteCode;
  severity: WasteSeverity;
  title: string;
  /** Human-readable explanation pointing at concrete examples (≤2 lines). */
  explanation: string;
  /**
   * Best-effort token waste estimate. `null` when the detector can't
   * quantify (vs. a real `0`, which would mean "estimate computed and
   * came out to zero"). UI surfaces `null` as "—".
   */
  tokensSaveable: number | null;
  /** Copy-pasteable next step. */
  fix: string;
}

export type WasteGrade = "A" | "B" | "C" | "D" | "F";

export interface WasteOptimizerInput {
  /** All assistant + user turns for the project, across sessions. */
  turns: UsageTurn[];
  /** Configured MCP servers from `.mcp.json` / settings (project + local scope). */
  configuredMcpServers: McpServer[];
  /** Catalog of agents available to this project (user + plugin + project). */
  agents: AgentEntry[];
  /** Catalog of skills available to this project (user + plugin + project). */
  skills: SkillEntry[];
}

export interface WasteOptimizerInfo {
  grade: WasteGrade;
  findings: WasteFinding[];
  /** Counts that drove the grade — surfaced for tooltips. */
  counts: { high: number; medium: number; low: number; total: number };
}

// Path separators differ across platforms; JSONL Read entries on Windows
// machines often carry `\node_modules\` while Linux/macOS records use
// forward slashes. Match either.
const JUNK_PATH_RE = /(?:^|[\\/])(node_modules|\.git|dist|build|\.next)(?:[\\/]|$)/i;

// Conservative average tokens-per-Read estimate. Tool results aren't in
// the JSONL call args, so we approximate. Used by both the junk-reads
// and duplicate-reads detectors — the metric is "tokens you could have
// saved by not making this Read at all."
const READ_TOKENS_AVG = 1500;

// ── 1. Junk directory reads ──────────────────────────────────────────────────
//
// Reads pointed at `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`.
// Counted globally (any session), since the user-facing remediation is
// always "don't read these directories." Severity scales with raw count.

interface JunkRead {
  path: string;
  sessionId: string;
}

function detectJunkReads(turns: UsageTurn[]): {
  finding: WasteFinding | null;
  hits: JunkRead[];
} {
  const hits: JunkRead[] = [];
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    for (const tc of t.toolCalls) {
      if (tc.name !== "Read") continue;
      const p = tc.arguments?.file_path;
      if (typeof p !== "string") continue;
      if (JUNK_PATH_RE.test(p)) {
        hits.push({ path: p, sessionId: t.sessionId });
      }
    }
  }
  if (hits.length === 0) return { finding: null, hits };

  const severity: WasteSeverity =
    hits.length >= 20 ? "high" : hits.length >= 5 ? "medium" : "low";

  // Show up to 3 distinct paths in the explanation so the fix is concrete.
  const sampleSet = new Set<string>();
  for (const h of hits) {
    if (sampleSet.size >= 3) break;
    sampleSet.add(h.path);
  }
  const sample = [...sampleSet].join(", ");

  return {
    finding: {
      code: "junk-reads",
      severity,
      title: `${hits.length} read${hits.length === 1 ? "" : "s"} into excluded directories`,
      explanation: `Reads against build artifacts or VCS internals (${sample}). These rarely produce useful context but they cost tokens.`,
      tokensSaveable: hits.length * READ_TOKENS_AVG,
      fix: "Add the directories to your CLAUDE.md's exclusion list (or .gitignore-aware Read instructions). Most agents don't need to read node_modules, dist/, .next/, or .git/.",
    },
    hits,
  };
}

// ── 2. Duplicate reads ───────────────────────────────────────────────────────
//
// "Files read in 3+ distinct sessions without any intervening Edit/Write."
// We track the most recent Edit/Write timestamp per file path; a Read whose
// timestamp is after that threshold AND in a different session counts as
// a duplicate. The count of distinct dup-sessions per file determines the
// severity; we report the top offenders only.

interface DupReadAccum {
  /** Sessions in which this file was read post-last-edit, EXCLUDING the
   *  session that performed that last edit (otherwise that session's
   *  re-reads after its own edit would self-flag as duplicates). */
  sessions: Set<string>;
  /** Timestamp (ms) of last edit/write, or 0 if never. */
  lastEditMs: number;
  /** SessionId that performed the last edit/write, or null if never. */
  lastEditSessionId: string | null;
}

function detectDuplicateReads(turns: UsageTurn[]): WasteFinding | null {
  const byPath = new Map<string, DupReadAccum>();

  // Sort defensively: per-session JSONL is chronological but
  // `parseAllSessions` interleaves sessions in arbitrary order, and the
  // detector's lastEditMs vs readMs comparison spans sessions.
  const sorted = [...turns].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const t of sorted) {
    if (t.role !== "assistant") continue;
    const turnMs = Date.parse(t.timestamp);
    // Skip turns with unparseable timestamps. The `|| 0` fallback would
    // map them to Unix epoch, defeating the lastEditMs-vs-readMs ordering
    // (a `0`-stamped Edit resets `acc.lastEditMs` to 0, breaking dedup
    // for everything afterward; a `0`-stamped Read counts as duplicate
    // even though we don't know when it actually occurred).
    if (!Number.isFinite(turnMs)) continue;

    for (const tc of t.toolCalls) {
      const p =
        typeof tc.arguments?.file_path === "string"
          ? (tc.arguments.file_path as string)
          : null;
      if (!p) continue;

      let acc = byPath.get(p);
      if (!acc) {
        acc = { sessions: new Set(), lastEditMs: 0, lastEditSessionId: null };
        byPath.set(p, acc);
      }

      if (tc.name === "Read") {
        // Skip reads from the same session that just edited the file —
        // those aren't "duplicate without intervening edit," they're
        // re-reads by the editor itself. Without this guard, a session
        // that runs Read → Edit → Read would push itself into
        // `acc.sessions` after its own edit cleared the set and tip
        // a clean project over the 3-session threshold.
        if (turnMs >= acc.lastEditMs && t.sessionId !== acc.lastEditSessionId) {
          acc.sessions.add(t.sessionId);
        }
      } else if (tc.name === "Edit" || tc.name === "Write") {
        acc.lastEditMs = turnMs;
        acc.lastEditSessionId = t.sessionId;
        acc.sessions.clear();
      }
    }
  }

  const offenders: Array<{ path: string; sessions: number }> = [];
  for (const [p, acc] of byPath.entries()) {
    if (acc.sessions.size >= 3) {
      offenders.push({ path: p, sessions: acc.sessions.size });
    }
  }
  if (offenders.length === 0) return null;

  offenders.sort((a, b) => b.sessions - a.sessions);

  const peak = offenders[0].sessions;
  const severity: WasteSeverity =
    peak >= 8 ? "high" : peak >= 5 ? "medium" : "low";

  const sample = offenders
    .slice(0, 3)
    .map((o) => `${shortPath(o.path)} (×${o.sessions})`)
    .join(", ");

  const totalSessions = offenders.reduce((s, o) => s + o.sessions, 0);
  return {
    code: "duplicate-reads",
    severity,
    title: `${offenders.length} file${offenders.length === 1 ? "" : "s"} re-read across 3+ sessions`,
    explanation: `Same content reloaded without intervening edits: ${sample}. Each repeat re-pays the read cost.`,
    tokensSaveable: totalSessions * READ_TOKENS_AVG,
    fix: "Pin frequently-read files to CLAUDE.md @imports, or summarize their contents into a topic file Claude already loads.",
  };
}

function shortPath(p: string): string {
  if (p.length <= 60) return p;
  return `…${p.slice(-57)}`;
}

// ── 3. Unused MCP servers ────────────────────────────────────────────────────
//
// Configured MCP servers with zero `mcp__server__tool` invocations across the
// project's session JSONLs. Project + local + plugin scopes all surface in
// `configuredMcpServers`; we just want names.

function detectUnusedMcpServers(
  turns: UsageTurn[],
  configuredMcpServers: McpServer[]
): WasteFinding | null {
  if (configuredMcpServers.length === 0) return null;

  const used = new Set<string>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    for (const tc of t.toolCalls) {
      // mcp tool calls follow the `mcp__server__tool` convention.
      if (!tc.name.startsWith("mcp__")) continue;
      const server = tc.name.split("__")[1];
      if (server) used.add(server);
    }
  }

  // Use a Set so we don't double-count a server that appears in both
  // project and local scope (rare but possible).
  const configured = new Set<string>();
  for (const s of configuredMcpServers) configured.add(s.name);
  const unused: string[] = [];
  for (const name of configured) {
    if (!used.has(name)) unused.push(name);
  }
  if (unused.length === 0) return null;

  unused.sort();
  const severity: WasteSeverity =
    unused.length >= 5 ? "high" : unused.length >= 2 ? "medium" : "low";

  return {
    code: "unused-mcp-servers",
    severity,
    title: `${unused.length} MCP server${unused.length === 1 ? "" : "s"} configured but never invoked`,
    explanation: `Configured but unused in this project's sessions: ${unused.slice(0, 5).join(", ")}${unused.length > 5 ? ", …" : ""}.`,
    tokensSaveable: null, // MCP tool definitions cost system-prompt tokens; we don't measure that here.
    fix: "Remove unused MCP servers from .mcp.json (or local-scope ~/.claude.json). Each loaded server inflates the system prompt.",
  };
}

// ── 4. Ghost capabilities ────────────────────────────────────────────────────
//
// Agents and skills indexed for this project's user / plugin / project scope
// with zero invocations. We detect agent invocations from `Task` tool_use
// (subagent_type or agent name) and skills from `Skill` tool_use (skill
// name). Both detectors are deliberately conservative — false positives
// here mean a user removes a capability they actually use; we'd rather
// under-report than over-report.

function detectGhostCapabilities(
  turns: UsageTurn[],
  agents: AgentEntry[],
  skills: SkillEntry[]
): WasteFinding | null {
  const usedAgents = new Set<string>();
  const usedSkills = new Set<string>();

  for (const t of turns) {
    if (t.role !== "assistant") continue;
    for (const tc of t.toolCalls) {
      if (tc.name === "Task") {
        const a = tc.arguments;
        if (a) {
          // Claude Code records subagent_type or agent name in different
          // historical schemas; check both.
          const t1 = typeof a.subagent_type === "string" ? a.subagent_type : null;
          const t2 = typeof a.agent === "string" ? a.agent : null;
          if (t1) usedAgents.add(normalizeName(t1));
          if (t2) usedAgents.add(normalizeName(t2));
        }
      } else if (tc.name === "Skill") {
        const a = tc.arguments;
        if (a && typeof a.skill === "string") {
          usedSkills.add(normalizeName(a.skill));
        }
      }
    }
  }

  const ghostAgents = agents.filter((a) => !usedAgents.has(normalizeName(a.slug)));
  const ghostSkills = skills.filter((s) => !usedSkills.has(normalizeName(s.slug)));

  // Cap reporting — nobody wants to see 200 unused user-scope skills as
  // a "finding." Only emit when the count is non-trivial relative to total.
  const totalCapabilities = agents.length + skills.length;
  const ghostCount = ghostAgents.length + ghostSkills.length;
  if (totalCapabilities === 0) return null;
  if (ghostCount === totalCapabilities) {
    // No invocations of anything — likely a project that has never run a
    // session that uses Task/Skill. Don't blame the catalog; skip.
    return null;
  }

  // Only flag when the project has actually used SOME capabilities (so we
  // know the data is meaningful) AND the unused proportion is significant.
  if (ghostCount < 3) return null;

  const severity: WasteSeverity =
    ghostCount >= 20 ? "high" : ghostCount >= 8 ? "medium" : "low";

  const sample = [
    ...ghostAgents.slice(0, 3).map((a) => `@${a.slug}`),
    ...ghostSkills.slice(0, 3).map((s) => `/${s.slug}`),
  ]
    .slice(0, 4)
    .join(", ");

  return {
    code: "ghost-capabilities",
    severity,
    title: `${ghostCount} unused agent${ghostCount === 1 ? "" : "s"} & skill${ghostCount === 1 ? "" : "s"}`,
    explanation: `Indexed but never invoked in this project: ${sample}${ghostCount > 4 ? ", …" : ""}.`,
    tokensSaveable: null,
    fix: "Audit ~/.claude/agents and ~/.claude/skills. Disable or delete unused capabilities — they consume system-prompt tokens on every turn.",
  };
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// ── 5. Low read/edit ratio ───────────────────────────────────────────────────
//
// Sessions where Edit+Write count exceeds Read count by >3×. Signal: agent
// is editing without first reviewing. We aggregate across sessions, then
// flag projects where >25% of sessions exhibit this pattern.

function detectLowReadEditRatio(turns: UsageTurn[]): WasteFinding | null {
  // Group tool counts per session.
  const perSession = new Map<string, { reads: number; edits: number }>();
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    let entry = perSession.get(t.sessionId);
    if (!entry) {
      entry = { reads: 0, edits: 0 };
      perSession.set(t.sessionId, entry);
    }
    for (const tc of t.toolCalls) {
      if (tc.name === "Read") entry.reads++;
      else if (tc.name === "Edit" || tc.name === "Write") entry.edits++;
    }
  }

  // Filter to sessions with non-trivial activity — too few edits/reads
  // makes the ratio meaningless. Threshold: at least 5 edits in the session.
  let flaggedSessions = 0;
  let evaluatedSessions = 0;
  for (const { reads, edits } of perSession.values()) {
    if (edits < 5) continue;
    evaluatedSessions++;
    if (reads === 0 || edits / Math.max(reads, 1) > 3) flaggedSessions++;
  }
  if (evaluatedSessions === 0) return null;

  const ratio = flaggedSessions / evaluatedSessions;
  if (ratio < 0.25) return null;

  const severity: WasteSeverity =
    ratio >= 0.6 ? "high" : ratio >= 0.4 ? "medium" : "low";

  return {
    code: "low-read-edit-ratio",
    severity,
    title: `${flaggedSessions}/${evaluatedSessions} sessions edited without reading first`,
    explanation: `Sessions where Edit+Write count exceeded Read count by >3× — agent is changing files without reviewing them.`,
    tokensSaveable: null,
    fix: "In CLAUDE.md, add a rule: \"Read a file before editing it.\" Most regressions trace back to edits made without context.",
  };
}

// A–F grade rollup. Bucket boundaries:
//   A: 0 findings, or all-low (zero medium + zero high)
//   B: 1–2 medium, no high
//   C: 3+ medium, no high
//   D: exactly 1 high
//   F: 2+ high, OR >8 total findings (regardless of severity mix)

function gradeFromCounts(high: number, medium: number, total: number): WasteGrade {
  if (high >= 2 || total > 8) return "F";
  if (high >= 1) return "D";
  if (medium >= 3) return "C";
  if (medium >= 1) return "B";
  return "A";
}

/** Test seam — accepts a finding array so tests can pin the rollup
 *  without rebuilding the per-severity counts manually. */
function gradeFor(findings: WasteFinding[]): WasteGrade {
  let high = 0;
  let medium = 0;
  for (const f of findings) {
    if (f.severity === "high") high++;
    else if (f.severity === "medium") medium++;
  }
  return gradeFromCounts(high, medium, findings.length);
}

// ── Public entry point ───────────────────────────────────────────────────────

export function runWasteOptimizer(input: WasteOptimizerInput): WasteOptimizerInfo {
  const { turns, configuredMcpServers, agents, skills } = input;
  const findings: WasteFinding[] = [];

  const junkResult = detectJunkReads(turns);
  if (junkResult.finding) findings.push(junkResult.finding);

  const dup = detectDuplicateReads(turns);
  if (dup) findings.push(dup);

  const unusedMcp = detectUnusedMcpServers(turns, configuredMcpServers);
  if (unusedMcp) findings.push(unusedMcp);

  const ghosts = detectGhostCapabilities(turns, agents, skills);
  if (ghosts) findings.push(ghosts);

  const lowRatio = detectLowReadEditRatio(turns);
  if (lowRatio) findings.push(lowRatio);

  const sevRank: Record<WasteSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    // Tie-break by token impact (larger first); null impacts sort last.
    return (b.tokensSaveable ?? -1) - (a.tokensSaveable ?? -1);
  });

  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.severity === "high") high++;
    else if (f.severity === "medium") medium++;
    else low++;
  }

  return {
    grade: gradeFromCounts(high, medium, findings.length),
    findings,
    counts: { high, medium, low, total: findings.length },
  };
}

// Re-exported so tests can target the rollup directly without rebuilding
// the full input shape.
export const _internal = {
  detectJunkReads,
  detectDuplicateReads,
  detectUnusedMcpServers,
  detectGhostCapabilities,
  detectLowReadEditRatio,
  gradeFor,
};

