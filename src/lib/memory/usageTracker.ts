import path from "path";
import { parseAllSessions } from "@/lib/usage/parser";
import type { UsageTurn } from "@/lib/usage/types";
import type { ProjectData } from "@/lib/types";

// Memory Observatory Phase 1, Feature B. Replay session JSONLs to count how
// often each memory file (user CLAUDE.md, project CLAUDE.md, auto-memory
// body) has been opened by Claude Code. The aggregation runs over the
// existing `parseAllSessions()` cache — no second JSONL pass, no parser
// modification. Write-through to SQLite (migration v13) for durable storage.

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
      void persistUsageMap(result).catch(() => {});
      return result;
    } finally {
      g.__memoryUsageInFlight = undefined;
    }
  })();

  return g.__memoryUsageInFlight;
}

/**
 * Pure aggregator. Walks every assistant turn's tool_use blocks and counts
 * Read events whose `file_path` argument is a memory path. Grep + Glob
 * targeting memory dirs are NOT counted per-file (their `path` argument is
 * a directory, not a file — there's no specific row to attribute the read
 * to). They show up in the existing tool-usage analytics on /usage instead.
 *
 * Exported for unit testing — `getMemoryUsage` is the production entry point.
 */
export function aggregateMemoryReads(
  sessions: Map<string, UsageTurn[]>,
  projects: ProjectData[],
): Map<string, MemoryUsageStat> {
  const projectPaths = projects.map((p) => p.path);
  const result = new Map<string, MemoryUsageStat>();

  for (const turns of sessions.values()) {
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      for (const tc of turn.toolCalls) {
        if (tc.name !== "Read") continue;
        const filePath = tc.arguments?.file_path;
        if (typeof filePath !== "string" || !filePath) continue;
        if (!isMemoryPath(filePath, projectPaths)) continue;
        const norm = normalizePath(filePath);
        const existing = result.get(norm);
        if (!existing) {
          result.set(norm, { readCount: 1, lastReadAt: turn.timestamp });
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
 * Case-insensitive on Windows. Normalizes back/forward slashes so the same
 * JSONL emitted on either platform classifies the same way.
 */
export function isMemoryPath(absPath: string, projectPaths: string[]): boolean {
  if (!absPath) return false;
  const norm = absPath.replace(/\\/g, "/");
  const lower = norm.toLowerCase();
  // User CLAUDE.md
  if (/\/\.claude\/claude\.md$/.test(lower)) return true;
  // Auto-memory body file
  if (/\/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/.test(lower)) return true;
  // Project CLAUDE.md
  for (const p of projectPaths) {
    const projNorm = p.replace(/\\/g, "/").toLowerCase();
    if (lower === `${projNorm}/claude.md`) return true;
  }
  return false;
}

function normalizePath(p: string): string {
  // Use path.resolve to canonicalize separators, then return as-is. We don't
  // realpath (no symlink resolution) — abs_path is the literal file_path
  // argument Claude Code emitted, which is what the user actually edited.
  return path.resolve(p);
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
