import { promises as fs } from "fs";
import path from "path";
import { watch, FSWatcher } from "fs";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { invalidateCache } from "./cache";
import { readConfig, getDevRoots } from "./config";
import { ManualStepsInfo } from "./types";
const DEBOUNCE_MS = 500;
const POLL_INTERVAL = 60_000; // 60s - check for new MANUAL_STEPS.md files
const CHANGE_RETENTION = 5 * 60_000; // 5 minutes
const WORKTREE_SEP = "--claude-worktrees-";

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
  entryCount: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

class ManualStepsWatcher {
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
      entryCount: info.entries.length,
      debounceTimer: null,
    };

    try {
      entry.watcher = watch(filePath, (_event, filename) => {
        // Ignore our atomic-write temp files
        if (filename && filename.includes(".tmp.")) return;
        // Debounce — Windows fs.watch fires duplicate events
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => this.onFileChanged(entry), DEBOUNCE_MS);
      });

      entry.watcher.on("error", () => {
        // File may have been deleted
        entry.watcher?.close();
        entry.watcher = null;
      });
    } catch {
      // watch can throw if file is deleted between access check and watch
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
      const newEntryCount = info.entries.length;

      // Detect genuinely new entries (not just checkbox toggles)
      if (newEntryCount > entry.entryCount) {
        const newEntries = info.entries.slice(entry.entryCount);
        for (const e of newEntries) {
          this.changes.push({
            slug: entry.slug,
            projectName: entry.name,
            title: e.title,
            changedAt: new Date().toISOString(),
          });
        }
        // New entries added — invalidate scan cache so counts update
        invalidateCache();
      }

      entry.entryCount = newEntryCount;

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

  destroy() {
    for (const [, entry] of this.watched) {
      entry.watcher?.close();
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    }
    this.watched.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

// Singleton — persist across hot reloads in dev
const globalForWatcher = globalThis as unknown as {
  __manualStepsWatcher?: ManualStepsWatcher;
};
export const manualStepsWatcher =
  globalForWatcher.__manualStepsWatcher ||
  (globalForWatcher.__manualStepsWatcher = new ManualStepsWatcher());
