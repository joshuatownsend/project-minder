import path from "path";
import { parseAllSessions } from "@/lib/usage/parser";
import { normalizePath as toForwardSlashes } from "@/lib/platform";
import type { UsageTurn } from "@/lib/usage/types";
import type { ProjectData } from "@/lib/types";

// Replay session JSONLs to count how often each memory file (user CLAUDE.md,
// project CLAUDE.md, auto-memory body) has been opened by Claude Code. The
// aggregation runs over the existing `parseAllSessions()` cache — no second
// JSONL pass, no parser modification. Write-through to SQLite (memory_usage
// table) for durable storage across restarts.

const USER_CLAUDE_MD_RE = /\/\.claude\/claude\.md$/;
const AUTO_MEMORY_RE = /\/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/;

export interface MemoryUsageStat {
  readCount: number;
  /** ISO 8601 timestamp of the most recent Read event for this file. */
  lastReadAt: string;
}

const CACHE_TTL_MS = 5 * 60_000;

const g = globalThis as unknown as {
  __memoryUsageCache?: { data: Map<string, MemoryUsageStat>; cachedAt: number };
  __memoryUsageInFlight?: Promise<Map<string, MemoryUsageStat>>;
};

export function invalidateMemoryUsageCache(): void {
  g.__memoryUsageCache = undefined;
}

/**
 * Return the memory-read stats map, computing on cold cache. Path is
 * single-flight so a Pulse poll + a `/memory` mount can't trigger two
 * parallel JSONL sweeps. Best-effort write-through to SQLite — failure to
 * persist does not block the response.
 */
export async function getMemoryUsage(
  projects: ProjectData[],
): Promise<Map<string, MemoryUsageStat>> {
  const cached = g.__memoryUsageCache;
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  if (g.__memoryUsageInFlight) return g.__memoryUsageInFlight;

  g.__memoryUsageInFlight = (async () => {
    try {
      const sessions = await parseAllSessions();
      const result = aggregateMemoryReads(sessions, projects);
      g.__memoryUsageCache = { data: result, cachedAt: Date.now() };
      // Write-through is best-effort: a DB outage shouldn't break /memory.
      // Log the failure so a broken migration isn't invisible in the field.
      void persistUsageMap(result).catch((err) => {
        console.warn("[memory] usage write-through to SQLite failed:", err);
      });
      return result;
    } finally {
      g.__memoryUsageInFlight = undefined;
    }
  })();

  return g.__memoryUsageInFlight;
}

/**
 * Map key used by the usage map. Lowercased forward-slash form so the
 * scanner's `path.resolve(...)` output (Windows preserves case but compares
 * case-insensitively) and Claude Code's JSONL `file_path` argument (whatever
 * case the user typed) hash to the same bucket. Lookup sites MUST use this
 * function — comparing a raw absPath against a normalized key silently
 * misses on Windows.
 */
export function canonicalMemoryKey(absPath: string): string {
  return toForwardSlashes(path.resolve(absPath)).toLowerCase();
}

/**
 * Pure aggregator. Walks every assistant turn's tool_use blocks and counts
 * Read events whose `file_path` argument is a memory path. Grep + Glob
 * targeting memory dirs are excluded — their `path` argument is a directory,
 * not a file, so there's no per-row target to attribute the read to.
 *
 * Exported for unit testing; `getMemoryUsage` is the production entry point.
 */
export function aggregateMemoryReads(
  sessions: Map<string, UsageTurn[]>,
  projects: ProjectData[],
): Map<string, MemoryUsageStat> {
  const projectClaudeMdSet = new Set(
    projects.map((p) => `${toForwardSlashes(p.path).toLowerCase()}/claude.md`),
  );
  const result = new Map<string, MemoryUsageStat>();

  for (const turns of sessions.values()) {
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      for (const tc of turn.toolCalls) {
        if (tc.name !== "Read") continue;
        const filePath = tc.arguments?.file_path;
        if (typeof filePath !== "string" || !filePath) continue;
        if (!isMemoryPath(filePath, projectClaudeMdSet)) continue;
        const key = canonicalMemoryKey(filePath);
        const existing = result.get(key);
        if (!existing) {
          result.set(key, { readCount: 1, lastReadAt: turn.timestamp });
        } else {
          existing.readCount++;
          if (turn.timestamp > existing.lastReadAt) {
            existing.lastReadAt = turn.timestamp;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Recognize the three memory-path shapes:
 *   1. `~/.claude/CLAUDE.md` (user scope)
 *   2. `~/.claude/projects/<encoded>/memory/<anything>.md` (auto scope)
 *   3. A scanned project's `<projectPath>/CLAUDE.md` (project scope)
 *
 * The `.claude` substring guard is the cheap early-out — 99% of Read events
 * in a typical session target source files, not memory, and we'd rather
 * skip those with an `indexOf` than a regex test.
 */
export function isMemoryPath(absPath: string, projectClaudeMdSet: Set<string>): boolean {
  if (!absPath) return false;
  const lower = toForwardSlashes(absPath).toLowerCase();
  if (!lower.includes("/.claude") && !projectClaudeMdSet.has(lower)) return false;
  if (USER_CLAUDE_MD_RE.test(lower)) return true;
  if (AUTO_MEMORY_RE.test(lower)) return true;
  return projectClaudeMdSet.has(lower);
}

async function persistUsageMap(data: Map<string, MemoryUsageStat>): Promise<void> {
  // Dynamic imports because the DB stack lives behind server-only modules;
  // unit tests that mock parseAllSessions don't need the DB layer in scope.
  const { ensureSchemaReady } = await import("@/lib/data");
  const result = await ensureSchemaReady();
  if (!result.available) return;
  const { getDb } = await import("@/lib/db/connection");
  const db = await getDb();
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO memory_usage (abs_path, read_count, last_read_at, last_updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(abs_path) DO UPDATE SET
      read_count = excluded.read_count,
      last_read_at = excluded.last_read_at,
      last_updated_at = excluded.last_updated_at
  `);
  const now = new Date().toISOString();
  const tx = db.transaction((entries: Array<[string, MemoryUsageStat]>) => {
    for (const [absPath, stat] of entries) {
      stmt.run(absPath, stat.readCount, stat.lastReadAt, now);
    }
  });
  tx(Array.from(data.entries()));
}
