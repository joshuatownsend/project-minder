import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { inferLiveSessionStatus } from "@/lib/scanner/liveSessionStatus";
import { decodeDirName, toSlug } from "@/lib/scanner/claudeConversations";
import { WORKTREE_SEP } from "@/lib/scanner/worktrees";
import { getLiveProcesses } from "@/lib/claudeAgentsCli";
import type { ConversationEntry } from "@/lib/scanner/claudeConversations";
import type { LiveSession, LiveSessionStatus } from "@/lib/types";

// Lifted out of `app/api/status/route.ts` so /api/pulse can share the same
// cache without an internal HTTP hop or duplicating the build logic. Both
// routes call `getLiveStatusPayload()`; the first caller in any TTL window
// pays the FS cost, every subsequent caller hits the globalThis cache.
//
// TTL must be ≥ the pulse poll interval (5 s) — otherwise every pulse triggers
// a fresh FS sweep and the cache is functionally inert. We pad to 6 s so a
// pulse arriving slightly before its peer interval still hits the cache.

const API_CACHE_TTL = 6_000;
const SESSION_MAX_AGE_MS = 4 * 60 * 60_000;
const MTIME_EVICT_MS = 15 * 60_000;

interface MtimeCacheEntry { lastMtime: number; lastSeenAt: number }
export interface StatusPayload {
  generatedAt: string;
  sessions: LiveSession[];
  // `true` when `claude agents --json` ran successfully (whether or not it
  // returned any sessions). `false` when the CLI was missing/timed out/old —
  // consumers in that case must NOT treat `isLive: undefined` as evidence
  // of staleness and should fall back to the existing hook-server signals.
  cliAvailable: boolean;
}

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

  // Kick off the CLI call concurrently with the FS walk so its session-id set
  // can gate the SESSION_MAX_AGE_MS skip below: a long-idle but still-running
  // Claude Code session has a >4 h JSONL mtime, yet the CLI confirms its PID
  // is alive. Without this gate, that session would never enter `sessions[]`
  // and never get `isLive=true` tagged — defeating the verified-live merge.
  const liveProcessesPromise = getLiveProcesses();

  let dirents: import("fs").Dirent<string>[];
  try {
    dirents = await fs.readdir(projectsDir, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    const liveProcesses = await liveProcessesPromise;
    return {
      generatedAt: new Date().toISOString(),
      sessions: [],
      cliAvailable: liveProcesses !== null,
    };
  }

  const liveProcesses = await liveProcessesPromise;
  const liveSessionIds = liveProcesses ? new Set(liveProcesses.map((p) => p.sessionId)) : null;
  const cliAvailable = liveProcesses !== null;

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
          const sessionId = path.basename(file, ".jsonl");
          const isCliAlive = liveSessionIds?.has(sessionId) ?? false;
          if (now - fstat.mtime.getTime() > SESSION_MAX_AGE_MS && !isCliAlive) continue;

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

  // Merge `claude agents --json` liveness ground-truth. The CLI knows which
  // PIDs are actually running; the JSONL-mtime path only knows which files
  // were touched recently. When CLI is available, every session in our list
  // is tagged isLive=true|false; when unavailable, isLive stays undefined and
  // consumers fall back to the existing mtime-based heuristics.
  if (liveProcesses !== null) {
    const liveBySessionId = new Map(liveProcesses.map((p) => [p.sessionId, p]));
    for (const s of sessions) {
      const proc = liveBySessionId.get(s.sessionId);
      if (proc) {
        s.pid = proc.pid;
        s.isLive = true;
        // Date construction can throw RangeError on out-of-range timestamps
        // (>±8.64e15 ms). The typeguard already rejects NaN/Infinity, but a
        // finite-but-too-large value still falls through — guard here so a
        // single bad entry can't abort the whole merge loop.
        try {
          s.processStartedAt = new Date(proc.startedAt).toISOString();
        } catch { /* leave processStartedAt unset */ }
        if (proc.name) s.processName = proc.name;
      } else {
        s.isLive = false;
      }
    }
  }

  const priority: Record<LiveSessionStatus, number> = {
    approval: 0, working: 1, waiting: 2, other: 3,
  };
  sessions.sort((a, b) => {
    const diff = priority[a.status] - priority[b.status];
    if (diff !== 0) return diff;
    return new Date(b.mtime).getTime() - new Date(a.mtime).getTime();
  });

  return { generatedAt: new Date().toISOString(), sessions, cliAvailable };
}

/** Force-evict the cache so the next getLiveStatusPayload() call does a fresh scan. */
export function invalidateLiveStatusCache(): void {
  delete g.__statusApiCache;
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
