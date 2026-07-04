import { parseAllSessions } from "./usage/parser";
import { loadCatalog } from "./indexer/catalog";
import { runWasteOptimizer } from "./scanner/wasteOptimizer";
import { buildProjectTurnsIndex, lookupProjectTurns } from "./usage/projectMatch";
import { getCachedScan } from "./cache";
import { recordGradeSnapshots, type GradeSnapshotRow } from "./data/gradeSnapshots";

export type EfficiencyGrade = "A" | "B" | "C" | "D" | "F";

interface GradeEntry {
  grade: EfficiencyGrade;
  cachedAt: number;
}

interface QueueItem {
  slug: string;
  path: string;
}

const CACHE_TTL = 5 * 60_000;

class EfficiencyGradeCache {
  private cache = new Map<string, GradeEntry>();
  private queue: QueueItem[] = [];
  private running = false;
  private inFlight = 0; // items spliced out of queue but not yet stored
  private seen = new Set<string>();
  private generation = 0;

  enqueue(projects: { slug: string; path: string; hasSessions: boolean }[]) {
    for (const p of projects) {
      if (!p.hasSessions) continue;
      const cached = this.cache.get(p.slug);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL) continue;
      if (this.seen.has(p.slug)) continue;
      this.seen.add(p.slug);
      this.queue.push({ slug: p.slug, path: p.path });
    }

    if (!this.running && this.queue.length > 0) {
      this.running = true;
      void this.processQueue();
    }
  }

  private async processQueue() {
    const myGen = this.generation;

    // Load shared data once for all projects in the queue.
    let sessionMap: Awaited<ReturnType<typeof parseAllSessions>>;
    let catalog: Awaited<ReturnType<typeof loadCatalog>>;
    try {
      [sessionMap, catalog] = await Promise.all([
        parseAllSessions(),
        loadCatalog({ includeProjects: true }),
      ]);
    } catch {
      // Clear queue so stale items don't block future enqueue cycles.
      this.queue.length = 0;
      this.running = false;
      this.seen.clear();
      return;
    }

    if (myGen !== this.generation) return;

    const scan = getCachedScan();
    const projectPathMap = new Map(scan?.projects.map((p) => [p.slug, p.path]) ?? []);
    const mcpMap = new Map(
      scan?.projects.map((p) => [p.slug, p.mcpServers?.servers ?? []]) ?? []
    );

    // Index the session map once (by projectSlug AND projectDirName — the
    // same two keys `gatherProjectTurns` matches on) instead of re-scanning
    // every session per project in the drain loop below. With N projects and
    // M sessions that turns an O(N × M) full-map re-filter into one O(M)
    // pass plus O(1) bucket lookups per project (C5).
    const turnsIndex = buildProjectTurnsIndex(sessionMap);

    // Grade + finding-count rows to snapshot once the drain finishes (item
    // 4b). Accumulated across batches and written in one transaction at the
    // end so the per-project loop stays CPU-only.
    const snapshotRows: GradeSnapshotRow[] = [];

    // Drain queue: CPU-only per project after shared I/O is done.
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, 5);
      this.inFlight += batch.length;

      if (myGen !== this.generation) {
        this.inFlight -= batch.length;
        return;
      }

      for (const item of batch) {
        try {
          const path = projectPathMap.get(item.slug) ?? item.path;
          const turns = lookupProjectTurns(turnsIndex, item.slug, path);
          const info = runWasteOptimizer({
            turns,
            configuredMcpServers: mcpMap.get(item.slug) ?? [],
            agents: catalog.agents.filter(
              (a) => !a.projectSlug || a.projectSlug === item.slug
            ),
            skills: catalog.skills.filter(
              (s) => !s.projectSlug || s.projectSlug === item.slug
            ),
          });
          this.cache.set(item.slug, { grade: info.grade, cachedAt: Date.now() });
          snapshotRows.push({ slug: item.slug, grade: info.grade, counts: info.counts });
        } catch {
          // Skip this project; it'll be retried on the next enqueue cycle.
        }
        this.inFlight--;
      }

      // Yield the event loop between batches so we don't starve route handlers.
      if (this.queue.length > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // Persist today's grade snapshots (best-effort; never throws, degrades to
    // "no trend" when the DB is unavailable). Done after the drain so it
    // doesn't reintroduce per-project I/O into the CPU-only loop.
    await recordGradeSnapshots(snapshotRows);

    this.running = false;
    this.seen.clear();
    // Restart if enqueue() raced in while we were running the last batch.
    if (this.queue.length > 0) {
      this.running = true;
      void this.processQueue();
    }
  }

  get(slug: string): EfficiencyGrade | null {
    const entry = this.cache.get(slug);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL) return null;
    return entry.grade;
  }

  getAll(): Record<string, EfficiencyGrade> {
    const result: Record<string, EfficiencyGrade> = {};
    for (const [slug, entry] of this.cache) {
      if (Date.now() - entry.cachedAt < CACHE_TTL) {
        result[slug] = entry.grade;
      }
    }
    return result;
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  get total(): number {
    return this.cache.size;
  }

  dispose() {
    this.generation++;
    this.queue.length = 0;
    this.inFlight = 0;
    this.seen.clear();
    this.cache.clear();
    this.running = false;
  }
}

const globalForEGC = globalThis as unknown as {
  __efficiencyGradeCache?: EfficiencyGradeCache;
};
export const efficiencyGradeCache =
  globalForEGC.__efficiencyGradeCache ||
  (globalForEGC.__efficiencyGradeCache = new EfficiencyGradeCache());
