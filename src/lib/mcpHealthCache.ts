import { probeMcpServer } from "./mcpHealth";
import type { McpServer, McpHealth } from "./types";

/**
 * MCP Health Cache — the background-poller half of the live "MCP integrations
 * health strip". A `globalThis` singleton mirroring `githubActivityCache`: a
 * queue, a `seen` dedupe set, a `generation` counter for `dispose()` race
 * protection, batched `processQueue` with `BATCH_SIZE`/`BATCH_DELAY`, a 5-min
 * TTL, and `get`/`getAll`/`pending`/`total`/`dispose` accessors.
 *
 * Enqueued by `GET /api/mcp-health` (flag-gated) with the user-scope MCP server
 * list; read by the same route on the next poll. Every probe is internally
 * defensive (`probeMcpServer` never throws), so a bad URL or missing command
 * degrades to a cached verdict rather than blocking the strip. Keyed by server
 * name (unique within user scope).
 */

const CACHE_TTL = 5 * 60_000; // 5 min — matches githubActivityCache + scan cache
const BATCH_SIZE = 4; // probes are cheap (one fetch or fs-stat each)
const BATCH_DELAY = 300; // ms between batches

class McpHealthCache {
  private cache = new Map<string, McpHealth>();
  private queue: McpServer[] = [];
  private running = false;
  private seen = new Set<string>();
  // Items pulled off `queue` whose probes are still resolving — counted into
  // `pending` so the UI keeps polling mid-batch (mirrors githubActivityCache).
  private inFlight = 0;
  // Bumped by dispose(); processQueue() snapshots it and drops results that
  // land after a dispose().
  private generation = 0;

  enqueue(servers: McpServer[]) {
    for (const s of servers) {
      const cached = this.cache.get(s.name);
      // down/unknown verdicts are cached too — don't re-probe a dead endpoint
      // every poll until TTL expires.
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL) continue;
      if (this.seen.has(s.name)) continue;
      this.seen.add(s.name);
      this.queue.push(s);
    }

    if (!this.running && this.queue.length > 0) {
      this.running = true;
      void this.processQueue();
    }
  }

  private async processQueue() {
    const myGen = this.generation;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      this.inFlight += batch.length;

      let results: { name: string; health: Omit<McpHealth, "checkedAt"> }[];
      try {
        results = await Promise.all(
          batch.map(async (s) => {
            try {
              return { name: s.name, health: await probeMcpServer(s) };
            } catch {
              // probeMcpServer is internally defensive; belt-and-suspenders.
              return {
                name: s.name,
                health: {
                  name: s.name,
                  transport: s.transport,
                  status: "unknown" as const,
                  detail: "probe error",
                  probeKind: "none" as const,
                },
              };
            }
          }),
        );
      } finally {
        if (myGen === this.generation) this.inFlight -= batch.length;
      }

      // Drop the batch if dispose() ran while we were awaiting.
      if (myGen !== this.generation) return;

      for (const { name, health } of results) {
        this.cache.set(name, { ...health, checkedAt: Date.now() });
      }

      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    this.running = false;
    this.seen.clear();
  }

  get(name: string): McpHealth | null {
    const entry = this.cache.get(name);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > CACHE_TTL) return null;
    return entry;
  }

  getAll(): Record<string, McpHealth> {
    const result: Record<string, McpHealth> = {};
    for (const [name, entry] of this.cache) {
      if (Date.now() - entry.checkedAt < CACHE_TTL) {
        result[name] = entry;
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

  /** Drain the queue, forget cached verdicts, and invalidate any in-flight
   *  batch (generation bump). Used by the feature-flag hot-toggle path. */
  dispose() {
    this.generation++;
    this.queue.length = 0;
    this.seen.clear();
    this.cache.clear();
    this.running = false;
    this.inFlight = 0;
  }
}

// Singleton — persist across hot reloads in dev.
const globalForMHC = globalThis as unknown as {
  __mcpHealthCache?: McpHealthCache;
};
export const mcpHealthCache =
  globalForMHC.__mcpHealthCache || (globalForMHC.__mcpHealthCache = new McpHealthCache());
