import "server-only";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { bridgeJsonlAppendToEventBus } from "./eventBus";
import { invalidateLiveStatusCache } from "@/lib/liveStatus";
import { decodeDirName, toSlug } from "@/lib/scanner/claudeConversations";
import { WORKTREE_SEP } from "@/lib/scanner/worktrees";

// Watches ~/.claude/projects/ recursively so the SSE snapshot fires within
// ~200ms of a new session starting — ahead of liveStatus.ts's 6s cache TTL.
// On Linux, fs.promises.watch throws ERR_FS_WATCH_NOT_RECURSIVE — caught and
// silently degraded; the existing mtime fallback remains active.

const DEBOUNCE_MS = 200;

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const g = globalThis as unknown as {
  __minderJsonlWatcher?: unknown;
  __minderJsonlWatcherDebounce?: Map<string, NodeJS.Timeout>;
};

export function parseJsonlPath(
  projectsDir: string,
  filePath: string,
): { projectSlug: string; sessionId: string } | null {
  if (!filePath.endsWith(".jsonl")) return null;
  const rel = path.relative(projectsDir, filePath);
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;

  const [rawDir, fileName] = parts;
  const sessionId = path.basename(fileName, ".jsonl");
  if (!sessionId || sessionId === fileName) return null;

  // e.g. "C-dev-proj--claude-worktrees-branchname" → strip to parent dir name
  const markerIdx = rawDir.indexOf(WORKTREE_SEP);
  const dirName = markerIdx !== -1 ? rawDir.slice(0, markerIdx) : rawDir;

  const decoded = decodeDirName(dirName);
  const baseName = path.basename(decoded);
  const projectSlug = toSlug(baseName);

  return { projectSlug, sessionId };
}

function scheduleEmit(filePath: string): void {
  if (!g.__minderJsonlWatcherDebounce) g.__minderJsonlWatcherDebounce = new Map();
  const debounce = g.__minderJsonlWatcherDebounce;
  const existing = debounce.get(filePath);
  if (existing) clearTimeout(existing);
  debounce.set(filePath, setTimeout(() => {
    debounce.delete(filePath);
    const parsed = parseJsonlPath(PROJECTS_DIR, filePath);
    if (parsed) {
      invalidateLiveStatusCache();
      bridgeJsonlAppendToEventBus(parsed.sessionId, parsed.projectSlug);
    }
  }, DEBOUNCE_MS));
}

export function startJsonlWatcher(): void {
  if (g.__minderJsonlWatcher) return;
  g.__minderJsonlWatcher = true;

  fs.access(PROJECTS_DIR).then(async () => {
    try {
      const watcher = fs.watch(PROJECTS_DIR, { recursive: true });
      g.__minderJsonlWatcher = watcher;
      for await (const { filename } of watcher) {
        if (typeof filename !== "string") continue;
        if (!filename.endsWith(".jsonl")) continue;
        scheduleEmit(path.join(PROJECTS_DIR, filename));
      }
    } catch {
      // Recursive watch not supported (Linux) — permanent sentinel prevents retries.
      g.__minderJsonlWatcher = "unsupported";
    }
  }).catch(() => {
    // ~/.claude/projects doesn't exist yet — normal for fresh installs.
    g.__minderJsonlWatcher = null;
  });
}
