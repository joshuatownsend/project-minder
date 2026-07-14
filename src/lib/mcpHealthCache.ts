import { probeMcpServer } from "./mcpHealth";
import type { McpServer, McpHealth } from "./types";

/**
 * MCP Health Cache — the background-poller half of the live "MCP integrations
 * health strip". A `globalThis` singleton mirroring `githubActivityCache`: a
 * queue, a `seen` dedupe set, a `generation` counter for `dispose()` race
 * protection, batched `processQueue` with `BATCH_SIZE`/`BATCH_DELAY`, a 5-min
 * TTL, and `get`/`getAll`/`pending`/`total`/`dispose` accessors.
 *
 * Enqueued by `GET /api/mcp-health` (flag-gated) with the merged user-scope MCP
 * server list; read by the same route on the next poll. Every probe is
 * internally defensive (`probeMcpServer` never throws), so a bad URL or missing
 * command degrades to a cached verdict rather than blocking the strip.
 *
 * Keyed by a composite identity (source + sourcePath + name), NOT name alone:
 * `getUserConfig` deliberately preserves two servers that share a name across
 * sources, so a name-only key would collapse them and probe/display the wrong
 * one. Within one identity, a config signature (transport/command/args/url/
 * disabled) detects a redefinition so a server that repoints under the same
 * name re-probes immediately instead of at TTL.
 */

const CACHE_TTL = 5 * 60_000; // 5 min — matches githubActivityCache + scan cache
const BATCH_SIZE = 4; // probes are cheap (one fetch or fs-stat each)
const BATCH_DELAY = 300; // ms between batches

// Field separator for identity/signature strings. NUL can never appear in a
// config value, so it can't cause a false key collision — but it must be
// produced from plain-text source (String.fromCharCode(0)), never a literal NUL
// byte in the file, or Git classifies the source as binary and diffs show only
// "Binary files differ" (Codex P3 on the first cut of this file).
const SEP = String.fromCharCode(0);

/** Stable identity of a configured server across enqueue cycles. Distinguishes
 *  two same-name servers from different sources (or source files). */
export function serverIdentity(s: McpServer): string {
  return [s.source, s.sourcePath, s.name].join(SEP);
}

/** A fingerprint of the parts of a definition that change what a probe returns.
 *  If it differs within one identity, the cached verdict is stale even within
 *  TTL — a server can keep its identity but repoint its command/url/transport. */
function serverSignature(s: McpServer): string {
  return [
    s.transport,
    s.command ?? "",
    (s.args ?? []).join(" "),
    s.url ?? "",
    s.disabled ? "1" : "0",
  ].join(SEP);
}

interface CacheEntry {
  health: McpHealth;
  sig: string;
}

class McpHealthCache {
  private cache = new Map<string, CacheEntry>();
  private queue: McpServer[] = [];
  private running = false;
  private seen = new Set<string>();
  // Items pulled off `queue` whose probes are still resolving — counted into
  // `pending` so the UI keeps polling mid-batch (mirrors githubActivityCache).
  private inFlight = 0;
  // Bumped by dispose(); processQueue() snapshots it and drops results that
  // land after a dispose().
  private generation = 0;
  // Opt-in stdio `initialize` handshake mode (the mcpHealthStdioProbe flag),
  // set by the route each poll. Threaded into every probe.
  private stdioHandshake = false;

  /** Toggle the stdio handshake mode. Changing it clears the cache so every
   *  server re-probes with the new mode on the next enqueue (a handshake verdict
   *  differs from the launchability one). */
  setStdioHandshake(enabled: boolean) {
    if (enabled === this.stdioHandshake) return;
    this.stdioHandshake = enabled;
    this.dispose();
  }

  enqueue(servers: McpServer[]) {
    for (const s of servers) {
      const id = serverIdentity(s);
      const cached = this.cache.get(id);
      // down/unknown verdicts are cached too — don't re-probe a dead endpoint
      // every poll until TTL expires. But a fresh entry is only reusable if the
      // definition is unchanged: a same-identity server that repointed its
      // command/url/transport must be re-probed now, not at TTL.
      if (
        cached &&
        Date.now() - cached.health.checkedAt < CACHE_TTL &&
        cached.sig === serverSignature(s)
      ) {
        continue;
      }
      if (this.seen.has(id)) continue;
      this.seen.add(id);
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

      let results: { id: string; sig: string; health: Omit<McpHealth, "checkedAt"> }[];
      try {
        results = await Promise.all(
          batch.map(async (s) => {
            const id = serverIdentity(s);
            const sig = serverSignature(s);
            try {
              return { id, sig, health: await probeMcpServer(s, { stdioHandshake: this.stdioHandshake }) };
            } catch {
              // probeMcpServer is internally defensive; belt-and-suspenders.
              return {
                id,
                sig,
                health: {
                  name: s.name,
                  transport: s.transport,
                  source: s.source,
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

      for (const { id, sig, health } of results) {
        this.cache.set(id, { health: { ...health, checkedAt: Date.now() }, sig });
      }

      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    this.running = false;
    this.seen.clear();
  }

  /** Look up a verdict by server identity (see `serverIdentity`). */
  get(id: string): McpHealth | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (Date.now() - entry.health.checkedAt > CACHE_TTL) return null;
    return entry.health;
  }

  /** All fresh verdicts, keyed by server identity. */
  getAll(): Record<string, McpHealth> {
    const result: Record<string, McpHealth> = {};
    for (const [id, entry] of this.cache) {
      if (Date.now() - entry.health.checkedAt < CACHE_TTL) {
        result[id] = entry.health;
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
