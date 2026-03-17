import { promises as fs } from "fs";
import path from "path";
import { watch, FSWatcher } from "fs";
import { parseManualStepsMd } from "./scanner/manualStepsMd";
import { invalidateCache } from "./cache";
import { ManualStepsInfo } from "./types";

const DEV_ROOT = "C:\\dev";
const DEBOUNCE_MS = 500;
const POLL_INTERVAL = 60_000; // 60s - check for new MANUAL_STEPS.md files
const CHANGE_RETENTION = 5 * 60_000; // 5 minutes

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
    try {
      const dirents = await fs.readdir(DEV_ROOT, { withFileTypes: true });
      const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);

      for (const dirName of dirs) {
        const slug = dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        if (this.watched.has(slug)) continue;

        const filePath = path.join(DEV_ROOT, dirName, "MANUAL_STEPS.md");
        try {
          await fs.access(filePath);
          await this.watchFile(slug, dirName, filePath);
          // New file discovered — invalidate scan cache so dashboard picks it up
          invalidateCache();
        } catch {
          // No MANUAL_STEPS.md in this project
        }
      }
    } catch {
      // DEV_ROOT doesn't exist or isn't readable
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
      entry.watcher = watch(filePath, () => {
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
