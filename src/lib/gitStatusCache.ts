import { scanGitDirtyStatus } from "./scanner/git";
import { checkWslRoot, parseWslUncPath } from "./wsl";
import { emitMinderEvent } from "./events/bus";

interface DirtyStatus {
  isDirty: boolean;
  uncommittedCount: number;
  checkedAt: number;
  /** Passed through from scanGitDirtyStatus (B5) — a failed git invocation,
   *  not a confirmed-clean repo. Optional so existing callers/tests that
   *  don't check it are unaffected. */
  unknown?: boolean;
  /** The never-wake sentinel: git was deliberately not run because the
   *  project sits under a stopped WSL distro. Kept on a short TTL and purged
   *  by manual rescan so a restarted distro isn't stuck "unknown" for the
   *  full 5-minute TTL. */
  wslBlocked?: boolean;
}

interface QueueItem {
  slug: string;
  path: string;
}

const CACHE_TTL = 5 * 60_000; // 5 minutes
// Stopped-WSL sentinels expire fast (matches the wsl.ts negative-state TTL):
// they describe a transient VM state, not a git result, and must not pin
// "status unavailable" for 5 minutes after the user starts the distro.
const WSL_SENTINEL_TTL = 30_000;
const BATCH_SIZE = 3;
const BATCH_DELAY = 500; // ms between batches

function ttlFor(entry: DirtyStatus): number {
  return entry.wslBlocked ? WSL_SENTINEL_TTL : CACHE_TTL;
}

class GitStatusCache {
  private cache = new Map<string, DirtyStatus>();
  private queue: QueueItem[] = [];
  private running = false;
  private seen = new Set<string>(); // prevent duplicate queue entries per cycle
  // Bumped by dispose(); processQueue() snapshots it at start and drops
  // any awaited results that landed after a dispose(). Without this, a
  // dispose() that lands mid-batch silently has its cache.clear() undone
  // when the in-flight scanGitDirtyStatus resolves.
  private generation = 0;

  enqueue(projects: QueueItem[]) {
    for (const p of projects) {
      // Skip if already cached and fresh, or already in queue
      const cached = this.cache.get(p.slug);
      if (cached && Date.now() - cached.checkedAt < ttlFor(cached)) continue;
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
    const myGen = this.generation;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (item) => {
          try {
            // Never-wake preflight: carried-forward projects under a stopped
            // WSL distro reach this queue with \\wsl.localhost paths, and
            // spawning git against one would auto-start the VM. Report
            // status-unknown instead (B5 semantics) until the distro runs.
            // Sync-parse first so non-WSL paths reach scanGitDirtyStatus
            // without an extra microtask (the dispose-race tests rely on the
            // git call starting synchronously within the batch mapper).
            if (parseWslUncPath(item.path)) {
              const wslCheck = await checkWslRoot(item.path);
              if (wslCheck && !wslCheck.ok) {
                return { slug: item.slug, status: { isDirty: false, uncommittedCount: 0, unknown: true, wslBlocked: true } };
              }
            }
            const status = await scanGitDirtyStatus(item.path);
            return { slug: item.slug, status };
          } catch {
            return { slug: item.slug, status: { isDirty: false, uncommittedCount: 0 } };
          }
        })
      );

      // Drop the batch if dispose() ran while we were awaiting — otherwise
      // these writes would repopulate the cache the user just cleared.
      if (myGen !== this.generation) return;

      for (const { slug, status } of results) {
        this.cache.set(slug, {
          ...status,
          checkedAt: Date.now(),
        });
      }
      // Tell SSE clients a batch landed so `useGitDirtyStatus` refetches
      // (replaces its 5s poll when the liveEvents flag is on).
      emitMinderEvent("git-status.updated");

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
    if (Date.now() - entry.checkedAt > ttlFor(entry)) return null;
    return entry;
  }

  getAll(): Record<string, DirtyStatus> {
    const result: Record<string, DirtyStatus> = {};
    for (const [slug, entry] of this.cache) {
      if (Date.now() - entry.checkedAt < ttlFor(entry)) {
        result[slug] = entry;
      }
    }
    return result;
  }

  /** Drop only the stopped-WSL sentinels so a user-initiated rescan re-probes
   *  those projects immediately (the distro may have just been started).
   *  Real git results keep their normal TTL. */
  invalidateWslSentinels() {
    for (const [slug, entry] of this.cache) {
      if (entry.wslBlocked) this.cache.delete(slug);
    }
  }

  /** Update cache from an on-demand check (detail page / MCP refresh tool).
   *  `unknown` MUST be threaded through: a failed git invocation returns
   *  isDirty:false/count:0, so without recording `unknown` the cache would
   *  store an exec failure as indistinguishable from a confirmed-clean repo
   *  (B5 / PR #251 review). */
  set(slug: string, isDirty: boolean, uncommittedCount: number, unknown?: boolean) {
    this.cache.set(slug, { isDirty, uncommittedCount, unknown, checkedAt: Date.now() });
  }

  get pending(): number {
    return this.queue.length;
  }

  get total(): number {
    return this.cache.size;
  }

  /** Drain the queue, forget cached statuses, and invalidate any in-flight
   *  processQueue() batch. Bumping generation makes processQueue() drop
   *  results that landed after this call — without that guard the awaited
   *  scanGitDirtyStatus subprocesses would repopulate the cache we just
   *  cleared. running=false lets the next enqueue() spin a fresh loop;
   *  callers can re-enable the cache by enqueueing again. Used by the
   *  (future) feature-flag hot-toggle path; today no UI calls this. */
  dispose() {
    this.generation++;
    this.queue.length = 0;
    this.seen.clear();
    this.cache.clear();
    this.running = false;
  }
}

// Singleton — persist across hot reloads in dev
const globalForGSC = globalThis as unknown as { __gitStatusCache?: GitStatusCache };
export const gitStatusCache =
  globalForGSC.__gitStatusCache || (globalForGSC.__gitStatusCache = new GitStatusCache());
