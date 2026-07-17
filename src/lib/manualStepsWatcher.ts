import { promises as fs } from "fs";
import path from "path";
import { watch, FSWatcher } from "fs";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { invalidateCache } from "./cache";
import { readConfig, getDevRoots } from "./config";
import { ManualStepsInfo, ManualStepEntry } from "./types";
const DEBOUNCE_MS = 500;
const POLL_INTERVAL = 60_000; // 60s - check for new MANUAL_STEPS.md files
const CHANGE_RETENTION = 5 * 60_000; // 5 minutes
const WORKTREE_SEP = "--claude-worktrees-";

/**
 * Stable identity for a MANUAL_STEPS.md entry — its dated header signature
 * (`date | slug | title`). Used to detect genuinely new entries across edits
 * (adds, prunes, archives, reorders) instead of relying on array position,
 * which silently misses a new entry whenever the same edit also removes an
 * older one. Required now that MANUAL_STEPS.md is a living checklist, not an
 * append-only log.
 */
export function manualStepEntryKey(
  e: Pick<ManualStepEntry, "date" | "featureSlug" | "title">
): string {
  return `${e.date}|${e.featureSlug}|${e.title}`;
}

/**
 * Diff a fresh parse of MANUAL_STEPS.md against the entry keys we've already
 * seen, tracked as a MULTISET (per-key counts) rather than a plain set. Returns
 * the entries that are new (the surplus over the previously-seen count for their
 * key) plus the new count map. Counting matters because two entries can share an
 * identical `date|slug|title` header — with a plain Set the second, genuinely-new
 * one would be silently treated as already-seen. Pure (no I/O), so unit-testable.
 */
export function diffNewManualStepEntries(
  prevCounts: Map<string, number>,
  entries: ManualStepEntry[]
): { newEntries: ManualStepEntry[]; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const budget = new Map(prevCounts);
  const newEntries: ManualStepEntry[] = [];
  for (const e of entries) {
    const key = manualStepEntryKey(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const remaining = budget.get(key) ?? 0;
    if (remaining > 0) {
      budget.set(key, remaining - 1); // matches a previously-seen entry
    } else {
      newEntries.push(e); // surplus beyond the seen count → genuinely new
    }
  }
  return { newEntries, counts };
}

/**
 * Decide whether a raw `fs.watch` event fired on the PARENT directory (see
 * B3) should trigger the debounced re-parse of `targetName`. Watching the
 * directory rather than the file itself means every change in the folder
 * reaches this listener — sibling files (TODO.md, .git housekeeping), and
 * the writer's own tmp-file intermediate from `atomicWrite.ts` — so events
 * must be filtered down to just the target file. Some platforms omit
 * `filename` entirely; when that happens we can't filter, so err on the
 * side of firing rather than silently missing a real change.
 */
export function shouldHandleWatchEvent(
  filename: string | null,
  targetName: string
): boolean {
  if (filename == null) return true;
  return filename === targetName;
}

interface ChangeEvent {
  slug: string;
  projectName: string;
  title: string;
  changedAt: string;
}

interface WatchedProject {
  slug: string;
  name: string;
  filePath: string;
  watcher: FSWatcher | null;
  seenCounts: Map<string, number>;
  prevTotalSteps: number;
  prevCompletedSteps: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class ManualStepsWatcher {
  private watched = new Map<string, WatchedProject>();
  private changes: ChangeEvent[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    await this.scanForFiles();
    this.pollTimer = setInterval(() => this.scanForFiles(), POLL_INTERVAL);
  }

  private async scanForFiles() {
    const config = await readConfig();
    const devRoots = getDevRoots(config);

    for (const devRoot of devRoots) {
      try {
        const dirents = await fs.readdir(devRoot, { withFileTypes: true });
        const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);

        for (const dirName of dirs) {
          // Skip worktree directories — handled in the dedicated loop below
          if (dirName.includes(WORKTREE_SEP)) continue;

          const slug = dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
          if (this.watched.has(slug)) continue;

          const filePath = path.join(devRoot, dirName, "MANUAL_STEPS.md");
          try {
            await fs.access(filePath);
            await this.watchFile(slug, dirName, filePath);
            // New file discovered — invalidate scan cache so dashboard picks it up
            invalidateCache();
          } catch {
            // No MANUAL_STEPS.md in this project
          }
        }

        // Discover MANUAL_STEPS.md in worktree directories
        for (const dirName of dirs) {
          if (!dirName.includes(WORKTREE_SEP)) continue;

          const sepIndex = dirName.indexOf(WORKTREE_SEP);
          const prefix = dirName.slice(0, sepIndex);
          const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length);

          // Build composite slug to avoid collision with main project
          const parentSlug = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "-");
          const compositeSlug = `${parentSlug}:worktree:${branchHint}`;

          if (this.watched.has(compositeSlug)) continue;

          // Derive display branch name: replace first hyphen with slash (e.g. feature-gitwc → feature/gitwc)
          const displayBranch = branchHint.replace("-", "/");
          const filePath = path.join(devRoot, dirName, "MANUAL_STEPS.md");
          try {
            await fs.access(filePath);
            await this.watchFile(compositeSlug, `${prefix} (${displayBranch})`, filePath);
            invalidateCache();
          } catch {
            // No MANUAL_STEPS.md in this worktree
          }
        }
      } catch {
        // This root doesn't exist or isn't readable — skip it
      }
    }
  }

  private async watchFile(slug: string, dirName: string, filePath: string) {
    const content = await fs.readFile(filePath, "utf-8").catch(() => "");
    const info = parseManualStepsMd(content);

    const entry: WatchedProject = {
      slug,
      name: dirName,
      filePath,
      watcher: null,
      // Seed with the current entries so existing steps don't fire on startup.
      seenCounts: diffNewManualStepEntries(new Map(), info.entries).counts,
      prevTotalSteps: info.totalSteps,
      prevCompletedSteps: info.completedSteps,
      debounceTimer: null,
    };

    // Watch the PARENT directory rather than the file itself, filtered to
    // the target filename (B3). A single-file `fs.watch` breaks once the
    // writer's tmp-file rename (`atomicWrite.ts`) replaces the underlying
    // inode — inotify stays bound to the unlinked old inode on Linux/macOS
    // (Windows generally survives this, but the parent-dir approach is
    // robust everywhere and needs no re-arming after every write).
    const parentDir = path.dirname(filePath);
    const targetName = path.basename(filePath);

    try {
      entry.watcher = watch(parentDir, (_event, filename) => {
        if (!shouldHandleWatchEvent(filename, targetName)) return;
        // Debounce — Windows fs.watch fires duplicate events
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => this.onFileChanged(entry), DEBOUNCE_MS);
      });

      entry.watcher.on("error", () => {
        // Directory watch broke (e.g. the dir itself was removed, or the
        // watch descriptor otherwise died). Evict the slug from `watched`
        // so the next 60s poll re-discovers and re-watches the file if it
        // still exists (or reappears) — otherwise a deleted-then-recreated
        // MANUAL_STEPS.md is orphaned until server restart (B2).
        entry.watcher?.close();
        entry.watcher = null;
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
          entry.debounceTimer = null;
        }
        this.watched.delete(slug);
      });
    } catch {
      // watch can throw if the dir is deleted between access check and watch
    }

    this.watched.set(slug, entry);
  }

  private async onFileChanged(entry: WatchedProject) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");

      // Guard: if the file reads as empty/near-empty, skip —
      // this is likely a partial read during a concurrent write.
      if (content.trim().length < 10) return;

      const info = parseManualStepsMd(content);

      // Detect genuinely new entries by header identity, counted as a multiset —
      // robust to checkbox toggles, pruning, archiving, reordering, AND a new
      // entry whose header collides with an existing one (a plain Set would drop
      // the duplicate; position-based diffing would miss an add coinciding with a
      // removal).
      const { newEntries, counts } = diffNewManualStepEntries(entry.seenCounts, info.entries);
      const prevTotal = [...entry.seenCounts.values()].reduce((a, b) => a + b, 0);

      if (newEntries.length > 0) {
        for (const e of newEntries) {
          this.changes.push({
            slug: entry.slug,
            projectName: entry.name,
            title: e.title,
            changedAt: new Date().toISOString(),
          });
          // Fire-and-forget push/telegram dispatch; os channel is handled browser-side
          import("@/lib/notifications/dispatcher")
            .then(({ dispatchManualStepAdded }) =>
              dispatchManualStepAdded({ slug: entry.slug, projectName: entry.name, title: e.title })
            )
            .catch((err: unknown) => {
              console.warn("[manualStepsWatcher] dispatch failed:", err);
            });
        }
      }

      // Invalidate the scan cache on ANY change that affects the dashboard's
      // view: entries added or removed/archived, OR step totals/completions
      // changing (e.g. an agent ticking a box directly in the file). Otherwise
      // card badges and the cross-project list keep a stale pending count until
      // the cache TTL expires.
      const stepsChanged =
        info.totalSteps !== entry.prevTotalSteps ||
        info.completedSteps !== entry.prevCompletedSteps;
      if (newEntries.length > 0 || info.entries.length !== prevTotal || stepsChanged) {
        invalidateCache();
      }

      entry.seenCounts = counts;
      entry.prevTotalSteps = info.totalSteps;
      entry.prevCompletedSteps = info.completedSteps;

      // Prune old changes
      const cutoff = Date.now() - CHANGE_RETENTION;
      this.changes = this.changes.filter(
        (c) => new Date(c.changedAt).getTime() > cutoff
      );
    } catch {
      // File may have been deleted
    }
  }

  getChanges(since: string): ChangeEvent[] {
    const sinceTime = new Date(since).getTime();
    return this.changes.filter(
      (c) => new Date(c.changedAt).getTime() > sinceTime
    );
  }

  async getAllPendingSteps(): Promise<
    { slug: string; name: string; manualSteps: ManualStepsInfo }[]
  > {
    const results: { slug: string; name: string; manualSteps: ManualStepsInfo }[] = [];

    for (const [, entry] of this.watched) {
      try {
        const content = await fs.readFile(entry.filePath, "utf-8");
        const info = parseManualStepsMd(content);
        if (info.pendingSteps > 0) {
          results.push({ slug: entry.slug, name: entry.name, manualSteps: info });
        }
      } catch {
        // skip
      }
    }

    return results;
  }

  /** Number of files currently under `fs.watch` (0 before init / after
   *  destroy). Read by `GET /api/health` for the watchers snapshot. */
  get watchedCount(): number {
    return this.watched.size;
  }

  destroy() {
    for (const [, entry] of this.watched) {
      entry.watcher?.close();
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    }
    this.watched.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.initialized = false;
  }

  /** Alias for `destroy()` — matches the vocabulary used by the
   *  feature-flag plan. No caller wires hot-toggling yet (today, the user
   *  must restart the dev server for the manualStepsWatcher flag to take
   *  effect). Calling dispose() on an uninitialized watcher is a no-op. */
  dispose() {
    this.destroy();
  }
}

// Singleton — persist across hot reloads in dev
const globalForWatcher = globalThis as unknown as {
  __manualStepsWatcher?: ManualStepsWatcher;
};
export const manualStepsWatcher =
  globalForWatcher.__manualStepsWatcher ||
  (globalForWatcher.__manualStepsWatcher = new ManualStepsWatcher());
