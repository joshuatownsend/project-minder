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
//
// Runs only while an Agent View stream is connected (#657): `agentViewWatchers`
// starts it on the first subscriber and stops it after the last one leaves.
//
// With the index on, ingest also reports each append (after it commits, relayed
// from its worker), so an append yields two snapshots. That is deliberate: this
// watcher's is the fast liveness signal and the live-status cache invalidation,
// ingest's is the one that carries current cost; with the index off, this is
// the only signal there is.

const DEBOUNCE_MS = 200;

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const g = globalThis as unknown as {
  /**
   * The running watcher's abort handle; "unsupported" once recursive watch has
   * failed (sticky — retrying cannot help); null/undefined when stopped.
   */
  __minderJsonlWatcher?: AbortController | "unsupported" | null;
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
  // Created synchronously, so a stop() that lands before the watcher exists
  // still cancels it — the `fs.access` hop below would otherwise install a
  // watcher nothing can close.
  const controller = new AbortController();
  g.__minderJsonlWatcher = controller;
  const { signal } = controller;

  fs.access(PROJECTS_DIR).then(async () => {
    if (signal.aborted) return;
    try {
      const watcher = fs.watch(PROJECTS_DIR, { recursive: true, signal });
      for await (const { filename } of watcher) {
        if (typeof filename !== "string") continue;
        if (!filename.endsWith(".jsonl")) continue;
        scheduleEmit(path.join(PROJECTS_DIR, filename));
      }
    } catch {
      // Recursive watch not supported (Linux) — permanent sentinel prevents
      // retries. The identity check makes a stop() (which rejects the iterator
      // with AbortError after clearing the slot) a no-op here, so stopping is
      // never mistaken for "unsupported".
      if (g.__minderJsonlWatcher === controller) g.__minderJsonlWatcher = "unsupported";
    }
  }).catch(() => {
    // ~/.claude/projects doesn't exist yet — normal for fresh installs.
    if (g.__minderJsonlWatcher === controller) g.__minderJsonlWatcher = null;
  });
}

/** Close the watcher and drop pending emits. Keeps the "unsupported" verdict. */
export function stopJsonlWatcher(): void {
  const current = g.__minderJsonlWatcher;
  if (current instanceof AbortController) {
    current.abort();
    g.__minderJsonlWatcher = null;
  }
  const debounce = g.__minderJsonlWatcherDebounce;
  if (debounce) {
    for (const t of debounce.values()) clearTimeout(t);
    debounce.clear();
  }
}
