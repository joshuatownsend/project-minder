import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  toSlug,
  type ConversationEntry,
} from "@/lib/scanner/claudeConversations";
import type { UsageTurn } from "./types";
import { FileCache } from "./cache";
import {
  extractText as extractTextRaw,
  extractToolResults as extractToolResultsRaw,
} from "./contentBlocks";

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Per-file mtime-keyed cache. Replaces the old 2-min TTL: with mtime caching,
// we only re-parse files that actually changed since last seen. Memory ceiling
// is bounded by FileCache's LRU sweep.
//
// Stored on globalThis so the cache survives Next.js HMR module reloads. Same
// rationale as the existing globalThis caches in /api/sessions, /api/stats etc.
const globalForParser = globalThis as unknown as {
  __usageFileCache?: FileCache<UsageTurn[]>;
  __usageAllSessionsInFlight?: Promise<Map<string, UsageTurn[]>>;
};

function getFileCache(): FileCache<UsageTurn[]> {
  if (!globalForParser.__usageFileCache) {
    globalForParser.__usageFileCache = new FileCache<UsageTurn[]>({ maxEntries: 5000 });
  }
  return globalForParser.__usageFileCache;
}

// Content extraction goes through `contentBlocks.ts` so the SQLite ingest
// path produces identical text projections. The slice limits below are
// the legacy file-parse caps (kept for the existing UsageTurn shape).

function extractText(content: any[]): string {
  return extractTextRaw(content).slice(0, 500);
}

function extractToolResults(content: any[]): string {
  return extractToolResultsRaw(content).slice(0, 2000);
}

// ── Dir name canonicalization ─────────────────────────────────────────────────

// In the encoded dir name, ':', '\', and '.' all become '-'.
// Windows paths start with '{Drive}--' (drive colon + first backslash).
// Any '--' after that initial prefix represents '\.' — a dot-prefixed component.
// Worktree dirs are always dot-prefixed (.worktrees, .claude-worktrees, etc.),
// so strip the worktree suffix to group their sessions with the parent project.
// We scan '--' occurrences left-to-right and stop at the FIRST worktree marker.
// Earlier dot-prefixed dirs (e.g. '--cache') don't match the pattern, so the
// loop naturally skips them. Stopping at the first match also ensures a branch
// name that happens to contain '--worktrees-' is never treated as a second marker.
export function canonicalizeDirName(dirName: string): string {
  const searchFrom = /^[A-Za-z]--/.test(dirName) ? 2 : 0;
  let pos = searchFrom;
  while (pos < dirName.length) {
    const idx = dirName.indexOf("--", pos);
    if (idx === -1) break;
    if (/^(?:[a-z]+-)?worktrees-/.test(dirName.slice(idx + 2))) {
      return dirName.slice(0, idx);
    }
    pos = idx + 2;
  }
  return dirName;
}

// ── Single-file parser ────────────────────────────────────────────────────────

export async function parseSessionTurns(
  filePath: string,
  projectDirName: string
): Promise<UsageTurn[]> {
  const sessionId = path.basename(filePath, ".jsonl");
  const canonicalDir = canonicalizeDirName(projectDirName);
  const projectSlug = toSlug(canonicalDir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const turns: UsageTurn[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: ConversationEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Skip internal entries
    if (entry.isSidechain) continue;
    if (entry.isMeta) continue;
    if (!entry.timestamp) continue;

    const { type, timestamp } = entry;

    if (type === "assistant") {
      const model = entry.message?.model;
      if (!model || model === "<synthetic>") continue;

      const usage = entry.message?.usage ?? {};
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      const toolCalls = (entry.message?.content ?? [])
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ name: b.name, arguments: b.input }));

      const isError = entry.isApiErrorMessage === true;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model,
        role: "assistant",
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        toolCalls,
        isError,
      });
    } else if (type === "user") {
      const messageContent = entry.message?.content ?? [];
      const topLevelContent = entry.content ?? [];

      // Prefer message.content, fall back to top-level content
      const textSource =
        messageContent.length > 0 ? messageContent : topLevelContent;
      const userMessageText = extractText(textSource) || undefined;
      const toolResultText = extractToolResults(textSource) || undefined;

      turns.push({
        timestamp,
        sessionId,
        projectSlug,
        projectDirName: canonicalDir,
        model: "",
        role: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        toolCalls: [],
        userMessageText,
        toolResultText,
      });
    }
  }

  return turns;
}

// ── All-sessions parser with mtime caching ───────────────────────────────────

async function buildAllSessions(): Promise<Map<string, UsageTurn[]>> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const cache = getFileCache();

  let subdirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return new Map();
  }

  const result = new Map<string, UsageTurn[]>();
  // Track every JSONL we observed during this sweep so we can evict slots for
  // files that were deleted since the last call. Without this, `maxMtimeMs()`
  // keeps reflecting a deleted file's mtime forever and ETags stick to a
  // value that no longer matches reality — clients would get 304s after a
  // session deletion even though the response body changed.
  const liveSet = new Set<string>();

  // Process subdirectories in batches of 5 to avoid overwhelming the FS.
  for (let i = 0; i < subdirs.length; i += 5) {
    const batch = subdirs.slice(i, i + 5);
    await Promise.all(
      batch.map(async (dirName) => {
        const dirPath = path.join(projectsDir, dirName);
        let files: string[];
        try {
          const entries = await fs.readdir(dirPath);
          files = entries.filter((f) => f.endsWith(".jsonl"));
        } catch {
          return;
        }

        for (const file of files) {
          const filePath = path.join(dirPath, file);
          liveSet.add(filePath);

          // FileCache stat's the file, returns the cached parse if mtime+size
          // are unchanged, otherwise calls the factory. Skip oversized files
          // before parsing — they're typically session-in-progress logs that
          // we'll re-evaluate on the next sweep when they may have been rolled.
          //
          // The factory has its own try/catch because a file can disappear in
          // the gap between the FileCache's outer stat and our second stat
          // (log rotation, session pruning). Pre-P1 behavior was "one bad
          // file doesn't kill the sweep" — keep it.
          const turns = await cache.getOrCompute(filePath, async (fp) => {
            try {
              const stat = await fs.stat(fp);
              if (stat.size > MAX_SESSION_FILE_SIZE) return [];
              return await parseSessionTurns(fp, dirName);
            } catch {
              return [];
            }
          });

          if (turns && turns.length > 0) {
            const sessionId = path.basename(file, ".jsonl");
            result.set(sessionId, turns);
          }
        }
      })
    );
  }

  // Evict slots for files that disappeared since the last sweep. This keeps
  // `maxMtimeMs()` honest as a change signal for ETag computation.
  cache.retainOnly(liveSet);
  return result;
}

export async function parseAllSessions(): Promise<Map<string, UsageTurn[]>> {
  // Single-flight: if pulse + dashboard mount fire in parallel on a cold
  // server, only one of them does the 1.1 GB sweep — the rest await the
  // same promise. After the first call settles, subsequent calls hit the
  // FileCache directly and stat 3k files (cheap), no full re-parse.
  if (globalForParser.__usageAllSessionsInFlight) {
    return globalForParser.__usageAllSessionsInFlight;
  }
  const promise = buildAllSessions().finally(() => {
    globalForParser.__usageAllSessionsInFlight = undefined;
  });
  globalForParser.__usageAllSessionsInFlight = promise;
  return promise;
}

/**
 * Max mtime across all currently cached JSONL files. Used as the input to
 * route ETag computation — when no file has changed since the last response,
 * the ETag is identical and the route can return 304.
 *
 * Note: this only reflects files that have been parsed at least once. Until
 * the first `parseAllSessions()` call completes, it returns 0.
 */
export function getJsonlMaxMtime(): number {
  return getFileCache().maxMtimeMs();
}

/**
 * Sentinel error from `loadSessionTurnsBySessionId` signaling that the
 * JSONL was found but failed to read or parse. Distinct from a `null`
 * return (file not found / oversized) so callers can route the two
 * outcomes to different HTTP statuses — 404 vs 500. Without this split
 * the diagnosis route would render a green "looks healthy" panel on a
 * file the parser couldn't actually read, which is the worst-case
 * failure mode for a quality-diagnosis tool.
 */
export class SessionTurnsLoadError extends Error {
  constructor(
    message: string,
    public readonly sessionId: string,
    public readonly filePath: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SessionTurnsLoadError";
  }
}

/**
 * Locate a single session's JSONL by session id and return its parsed
 * `UsageTurn[]`. Returns `null` when the session id doesn't resolve to
 * a file or the file exceeds the size cap. Throws `SessionTurnsLoadError`
 * when the JSONL was found but failed to read or parse — caller MUST
 * surface that distinctly from "not found" (see class doc).
 *
 * Used by surfaces that need a single session's full turn data
 * (e.g. the Diagnosis API route) without paying the cost of a full
 * `parseAllSessions` sweep on cold start.
 *
 * Implementation: walks `~/.claude/projects/<dir>/<sessionId>.jsonl`
 * across project subdirectories, mirroring `scanSessionDetail`'s
 * fallback. Returns the cached parse via `FileCache` on warm hits,
 * but read/parse failures bypass the cache so a transient EBUSY or
 * corrupt mid-stream line doesn't poison subsequent calls.
 */
export async function loadSessionTurnsBySessionId(
  sessionId: string
): Promise<UsageTurn[] | null> {
  if (!/^[a-f0-9-]+$/i.test(sessionId)) return null;

  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    // ENOENT is legitimate (no Claude Code on this machine, or fresh
    // install before any session); anything else (EACCES, EIO) is a
    // misconfiguration we want visible rather than masquerading as 404.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn(
        `[loadSessionTurnsBySessionId] readdir failed on ${projectsDir}`,
        err
      );
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    let stat;
    try {
      stat = await fs.stat(candidate);
    } catch {
      continue;
    }
    // Oversized files return null (treated as "not found" by the route's
    // 404 path). Per-turn diagnosis on a 50MB+ JSONL would also stress
    // the parser — bailing here is consistent with the buildAllSessions
    // sweep behavior.
    if (stat.size > MAX_SESSION_FILE_SIZE) return null;
    // Parse with explicit error propagation. We don't use the FileCache's
    // factory pattern here because that pattern swallows throws as `[]`
    // (correct for sweep, wrong for diagnosis — see SessionTurnsLoadError).
    // Diagnosis is single-session and infrequent, so skipping the cache
    // costs a re-parse on tab-revisit but never produces a misleading
    // healthy verdict on a broken file.
    let turns: UsageTurn[];
    try {
      turns = await parseSessionTurns(candidate, dir);
    } catch (err) {
      throw new SessionTurnsLoadError(
        `Failed to parse session JSONL: ${err instanceof Error ? err.message : String(err)}`,
        sessionId,
        candidate,
        err
      );
    }
    return turns;
  }
  return null;
}
