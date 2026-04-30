import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { inferLiveSessionStatus } from "@/lib/scanner/liveSessionStatus";
import { decodeDirName, toSlug } from "@/lib/scanner/claudeConversations";
import { WORKTREE_SEP } from "@/lib/scanner/worktrees";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import type { LiveSession, LiveSessionStatus } from "@/lib/types";

// Lifted out of `app/api/status/route.ts` so /api/pulse can share the same
// 3-second cache without an internal HTTP hop or duplicating the build logic.
// Both routes call `getLiveStatusPayload()`; the first caller in any 3-second
// window pays the FS cost, every subsequent caller hits the globalThis cache.

const API_CACHE_TTL = 3_000;
const SESSION_MAX_AGE_MS = 4 * 60 * 60_000;
const MTIME_EVICT_MS = 15 * 60_000;

interface MtimeCacheEntry { lastMtime: number; lastSeenAt: number }
export interface StatusPayload { generatedAt: string; sessions: LiveSession[] }

const g = globalThis as unknown as {
  __statusApiCache?: { data: StatusPayload; cachedAt: number };
  __statusApiFlight?: Promise<StatusPayload>;
  __statusMtimeCache?: Map<string, MtimeCacheEntry>;
};

async function readTailEntries(filePath: string): Promise<ConversationEntry[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean).slice(-200);
    const entries: ConversationEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* malformed line */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function dirToProjectInfo(dirName: string): {
  parentProjectName: string;
  parentSlug: string;
  worktreeLabel?: string;
} {
  const markerIdx = dirName.indexOf(WORKTREE_SEP);

  if (markerIdx !== -1) {
    const parentDirName = dirName.slice(0, markerIdx);
    const worktreeLabel = dirName.slice(markerIdx + WORKTREE_SEP.length);
    const parentPath = decodeDirName(parentDirName);
    const baseName = path.basename(parentPath);
    return { parentProjectName: baseName, parentSlug: toSlug(baseName), worktreeLabel };
  }

  const decodedPath = decodeDirName(dirName);
  const baseName = path.basename(decodedPath);
  return { parentProjectName: baseName, parentSlug: toSlug(baseName) };
}

async function buildStatusPayload(): Promise<StatusPayload> {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const sessions: LiveSession[] = [];
  const now = Date.now();

  if (!g.__statusMtimeCache) g.__statusMtimeCache = new Map();
  const mtimeCache = g.__statusMtimeCache;

  for (const [key, entry] of mtimeCache) {
    if (now - entry.lastSeenAt > MTIME_EVICT_MS) mtimeCache.delete(key);
  }

  let dirents: import("fs").Dirent<string>[];
  try {
    dirents = await fs.readdir(projectsDir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return { generatedAt: new Date().toISOString(), sessions: [] };
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dir = dirent.name;
    const dirPath = path.join(projectsDir, dir);
    try {
      const projectInfo = dirToProjectInfo(dir);
      const dirEntries = await fs.readdir(dirPath);
      const jsonlFiles = dirEntries.filter((f) => f.endsWith(".jsonl"));

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        try {
          const fstat = await fs.stat(filePath);
          if (now - fstat.mtime.getTime() > SESSION_MAX_AGE_MS) continue;

          const sessionId = path.basename(file, ".jsonl");
          const cacheKey = `${dir}/${sessionId}`;
          const previousMtimeMs = mtimeCache.get(cacheKey)?.lastMtime;

          const entries = await readTailEntries(filePath);
          const { status, lastToolName } = inferLiveSessionStatus(entries, fstat.mtime, previousMtimeMs);

          mtimeCache.set(cacheKey, { lastMtime: fstat.mtime.getTime(), lastSeenAt: now });

          sessions.push({
            sessionId,
            projectSlug: projectInfo.parentSlug,
            projectName: projectInfo.parentProjectName,
            worktreeLabel: projectInfo.worktreeLabel,
            status,
            mtime: fstat.mtime.toISOString(),
            lastToolName,
          });
        } catch { /* skip unreadable file */ }
      }
    } catch { /* skip inaccessible dir */ }
  }

  const priority: Record<LiveSessionStatus, number> = {
    approval: 0, working: 1, waiting: 2, other: 3,
  };
  sessions.sort((a, b) => {
    const diff = priority[a.status] - priority[b.status];
    if (diff !== 0) return diff;
    return new Date(b.mtime).getTime() - new Date(a.mtime).getTime();
  });

  return { generatedAt: new Date().toISOString(), sessions };
}

// Public API: returns the cached payload if fresh, otherwise dedupes
// concurrent rebuilds via __statusApiFlight so two near-simultaneous callers
// (e.g. /api/status and /api/pulse) don't each trigger a fresh FS sweep.
export async function getLiveStatusPayload(): Promise<StatusPayload> {
  const cache = g.__statusApiCache;
  if (cache && Date.now() - cache.cachedAt <= API_CACHE_TTL) {
    return cache.data;
  }
  if (!g.__statusApiFlight) {
    g.__statusApiFlight = buildStatusPayload()
      .then((data) => {
        g.__statusApiCache = { data, cachedAt: Date.now() };
        return data;
      })
      .finally(() => { g.__statusApiFlight = undefined; });
  }
  return g.__statusApiFlight;
}
