import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { FileCache } from "@/lib/usage/cache";
import { num, str, bool } from "@/lib/coerce";

// ── Claude Code's own data files (cc-lens-inspired, TODO item 2) ─────────────
//
// Two extra read-only sources Claude Code maintains under ~/.claude that the
// dashboard didn't previously read:
//
//   1. stats-cache.json — a single aggregate-stats file. We cross-check our
//      independently-computed totals against it; a large drift means our
//      parser and Claude's own counter disagree (a useful self-diagnostic).
//   2. usage-data/session-meta/<sessionId>.json — a rich per-session metadata
//      record (git activity, lines changed, tool-error categories, …) that we
//      surface on the session detail page.
//
// Both parse DEFENSIVELY: a missing file is "no data" (null), and a malformed
// file degrades to null rather than throwing. These are enrichment/diagnostic
// surfaces — a corrupt stats file must never break the page it decorates.
// (This is the deliberate difference from `claudeFacets.ts`, where malformed
// feedback throws loudly because it feeds aggregates.)

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, "stats-cache.json");
const SESSION_META_DIR = path.join(CLAUDE_DIR, "usage-data", "session-meta");

// ── small defensive coercers ─────────────────────────────────────────────────
// Scalar coercers (num/str/bool) are shared from `@/lib/coerce`.

/** Coerce a value to a Record<string, number>, dropping non-numeric members. */
function numRecord(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = num(val);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── stats-cache.json ──────────────────────────────────────────────────────────

export interface StatsCacheDay {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsCache {
  version?: number;
  lastComputedDate?: string;
  totalSessions?: number;
  totalMessages?: number;
  dailyActivity: StatsCacheDay[];
}

function parseStatsCache(j: unknown): StatsCache | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const dailyActivity: StatsCacheDay[] = Array.isArray(o.dailyActivity)
    ? (o.dailyActivity as unknown[])
        .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
        .filter((d) => typeof d.date === "string")
        .map((d) => ({
          date: d.date as string,
          messageCount: num(d.messageCount) ?? 0,
          sessionCount: num(d.sessionCount) ?? 0,
          toolCallCount: num(d.toolCallCount) ?? 0,
        }))
    : [];
  return {
    version: num(o.version),
    lastComputedDate: str(o.lastComputedDate),
    totalSessions: num(o.totalSessions),
    totalMessages: num(o.totalMessages),
    dailyActivity,
  };
}

const globalForStats = globalThis as unknown as {
  __statsCacheCache?: FileCache<StatsCache | null>;
  __sessionMetaCache?: FileCache<SessionMeta | null>;
};

function statsCacheStore(): FileCache<StatsCache | null> {
  if (!globalForStats.__statsCacheCache) {
    globalForStats.__statsCacheCache = new FileCache<StatsCache | null>({ maxEntries: 1 });
  }
  return globalForStats.__statsCacheCache;
}

/**
 * Read + parse a JSON file through a FileCache, degrading to null on a missing
 * file (FileCache yields `undefined`) OR malformed JSON (the factory catches).
 * Shared by both readers — neither must ever throw.
 */
async function readJsonCached<T>(
  store: FileCache<T | null>,
  filePath: string,
  parse: (json: unknown) => T | null
): Promise<T | null> {
  const result = await store.getOrCompute(filePath, async (fp) => {
    try {
      return parse(JSON.parse(await fs.readFile(fp, "utf8")));
    } catch {
      return null;
    }
  });
  return result ?? null;
}

/**
 * Read `~/.claude/stats-cache.json` — Claude Code's own aggregate stats.
 * Returns null when absent or malformed (degrade, never throw).
 */
export function getStatsCache(): Promise<StatsCache | null> {
  return readJsonCached(statsCacheStore(), STATS_CACHE_PATH, parseStatsCache);
}

// ── session-meta/<sessionId>.json ──────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string;
  projectPath?: string;
  startTime?: string;
  durationMinutes?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolCounts?: Record<string, number>;
  languages?: Record<string, number>;
  gitCommits?: number;
  gitPushes?: number;
  inputTokens?: number;
  outputTokens?: number;
  firstPrompt?: string;
  userInterruptions?: number;
  toolErrors?: number;
  toolErrorCategories?: Record<string, number>;
  usesTaskAgent?: boolean;
  usesMcp?: boolean;
  usesWebSearch?: boolean;
  usesWebFetch?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
  filesModified?: number;
}

/** Map Claude's snake_case session-meta record to our camelCase shape. */
function parseSessionMeta(j: unknown, fallbackId: string): SessionMeta | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  return {
    sessionId: str(o.session_id) ?? fallbackId,
    projectPath: str(o.project_path),
    startTime: str(o.start_time),
    durationMinutes: num(o.duration_minutes),
    userMessageCount: num(o.user_message_count),
    assistantMessageCount: num(o.assistant_message_count),
    toolCounts: numRecord(o.tool_counts),
    languages: numRecord(o.languages),
    gitCommits: num(o.git_commits),
    gitPushes: num(o.git_pushes),
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    firstPrompt: str(o.first_prompt),
    userInterruptions: num(o.user_interruptions),
    toolErrors: num(o.tool_errors),
    toolErrorCategories: numRecord(o.tool_error_categories),
    usesTaskAgent: bool(o.uses_task_agent),
    usesMcp: bool(o.uses_mcp),
    usesWebSearch: bool(o.uses_web_search),
    usesWebFetch: bool(o.uses_web_fetch),
    linesAdded: num(o.lines_added),
    linesRemoved: num(o.lines_removed),
    filesModified: num(o.files_modified),
  };
}

function sessionMetaStore(): FileCache<SessionMeta | null> {
  if (!globalForStats.__sessionMetaCache) {
    globalForStats.__sessionMetaCache = new FileCache<SessionMeta | null>({ maxEntries: 2000 });
  }
  return globalForStats.__sessionMetaCache;
}

/**
 * Read the session-meta record for one session. Returns null when absent
 * (no metadata recorded) or malformed (degrade, never throw).
 */
export function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const filePath = path.join(SESSION_META_DIR, `${sessionId}.json`);
  return readJsonCached(sessionMetaStore(), filePath, (json) =>
    parseSessionMeta(json, sessionId)
  );
}

// ── cross-check: Claude's totals vs ours ──────────────────────────────────────

export interface StatsCrossCheck {
  /** Whether stats-cache.json was found + parsed. */
  available: boolean;
  /** ISO date Claude last recomputed its cache, when known. */
  lastComputedDate: string | null;
  claudeSessions: number | null;
  observedSessions: number;
  /** (observed − claude) / claude. null when Claude's number is unknown. */
  sessionDriftRatio: number | null;
  claudeMessages: number | null;
  observedMessages: number;
  messageDriftRatio: number | null;
}

function driftRatio(claude: number | undefined, observed: number): number | null {
  if (claude === undefined) return null;
  if (claude === 0) return observed === 0 ? 0 : 1;
  return (observed - claude) / claude;
}

/**
 * Compare Claude Code's own aggregate counters against the totals we computed
 * independently. A large ratio means our parser is over- or under-counting
 * relative to Claude's bookkeeping — surfaced as a diagnostic, not an error.
 */
export function crossCheckStats(
  stats: StatsCache | null,
  observed: { sessions: number; messages: number }
): StatsCrossCheck {
  return {
    available: stats !== null,
    lastComputedDate: stats?.lastComputedDate ?? null,
    claudeSessions: stats?.totalSessions ?? null,
    observedSessions: observed.sessions,
    sessionDriftRatio: driftRatio(stats?.totalSessions, observed.sessions),
    claudeMessages: stats?.totalMessages ?? null,
    observedMessages: observed.messages,
    messageDriftRatio: driftRatio(stats?.totalMessages, observed.messages),
  };
}
