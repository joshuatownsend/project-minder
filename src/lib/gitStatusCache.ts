import { scanGitDirtyStatus } from "./scanner/git";

interface DirtyStatus {
  isDirty: boolean;
  uncommittedCount: number;
  checkedAt: number;
}

interface QueueItem {
  slug: string;
  path: string;
}

const CACHE_TTL = 5 * 60_000; // 5 minutes
const BATCH_SIZE = 3;
const BATCH_DELAY = 500; // ms between batches

class GitStatusCache {
  private cache = new Map<string, DirtyStatus>();
  private queue: QueueItem[] = [];
  private running = false;
  private seen = new Set<string>(); // prevent duplicate queue entries per cycle

  enqueue(projects: QueueItem[]) {
    for (const p of projects) {
      // Skip if already cached and fresh, or already in queue
      const cached = this.cache.get(p.slug);
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL) continue;
      if (this.seen.has(p.slug)) continue;

      this.seen.add(p.slug);
      this.queue.push(p);
    }

    if (!this.running && this.queue.length > 0) {
      this.running = true;
      this.processQueue();
    }
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (item) => {
          try {
            const status = await scanGitDirtyStatus(item.path);
            return { slug: item.slug, status };
          } catch {
            return { slug: item.slug, status: { isDirty: false, uncommittedCount: 0 } };
          }
        })
      );

      for (const { slug, status } of results) {
        this.cache.set(slug, {
          ...status,
          checkedAt: Date.now(),
        });
      }

      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    this.running = false;
    this.seen.clear();
  }

  get(slug: string): DirtyStatus | null {
    const entry = this.cache.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > CACHE_TTL) return null;
    return entry;
  }

  getAll(): Record<string, DirtyStatus> {
    const result: Record<string, DirtyStatus> = {};
    for (const [slug, entry] of this.cache) {
      if (Date.now() - entry.checkedAt < CACHE_TTL) {
        result[slug] = entry;
      }
    }
    return result;
  }

  /** Update cache from an on-demand check (detail page). */
  set(slug: string, isDirty: boolean, uncommittedCount: number) {
    this.cache.set(slug, { isDirty, uncommittedCount, checkedAt: Date.now() });
  }

  get pending(): number {
    return this.queue.length;
  }

  get total(): number {
    return this.cache.size;
  }
}

// Singleton — persist across hot reloads in dev
const globalForGSC = globalThis as unknown as { __gitStatusCache?: GitStatusCache };
export const gitStatusCache =
  globalForGSC.__gitStatusCache || (globalForGSC.__gitStatusCache = new GitStatusCache());
