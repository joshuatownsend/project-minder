// Shared bounded TTL cache for API route handlers (C3).
//
// ~20 route modules under `src/app/api` used to hand-roll the same ~15 lines:
// a `globalThis`-pinned `Map<key, {value, expiresAt}>`, a manual TTL check on
// read, and a manual sweep-expired loop on write. That pattern had three bugs
// baked in identically everywhere:
//   - No size cap. Distinct keys (session IDs, project slugs, filter combos)
//     accumulate for the life of the server — an unbounded per-route leak.
//   - No HMR dispose. Each hot reload in dev left the previous instance's
//     entries alive on `globalThis` forever (harmless for TTL-fresh data, but
//     it meant "restart to clear a cache" wasn't reliably true).
//   - ~20 near-identical copies of the same 15 lines with subtly different
//     TTLs, some sweeping every write, some using a Map, some a single slot.
//
// `TtlCache<T>` consolidates all of that into one bounded, testable class.
// Callers keep exactly the same externally-visible behavior (same TTL, same
// per-key storage) — this is a consolidation, not a behavior change.

export interface TtlCacheOptions {
  /** Time-to-live for each entry, in milliseconds. */
  ttlMs: number;
  /** Maximum entries before LRU eviction kicks in. Default: 500. */
  maxEntries?: number;
  /** Diagnostic name (also the registry key when created via
   *  `getOrCreateRouteCache`). Not required for a bare `new TtlCache()`. */
  name?: string;
}

interface Slot<T> {
  value: T;
  expiresAt: number;
  /** Bumped on both `get` and `set` — drives LRU eviction, same idea as
   *  `FileCache.evictIfNeeded`'s `lastSeenAt`. */
  lastAccess: number;
}

export class TtlCache<T> {
  private readonly slots = new Map<string, Slot<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  readonly name: string;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 500;
    this.name = opts.name ?? "unnamed";
  }

  /** Number of entries currently held, including any not-yet-swept expired
   *  ones (mirrors the pre-consolidation routes, which only swept on write). */
  get size(): number {
    return this.slots.size;
  }

  /** Returns the cached value, or `undefined` if absent or expired. An
   *  expired entry is deleted on access so a cache that's gone quiet still
   *  frees its expired slots without waiting for the next `set`. */
  get(key: string): T | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    if (Date.now() >= slot.expiresAt) {
      this.slots.delete(key);
      return undefined;
    }
    slot.lastAccess = Date.now();
    return slot.value;
  }

  /** Stores `value` under `key` with a fresh TTL. Sweeps expired entries and
   *  enforces `maxEntries` (LRU eviction) as a side effect, same as the
   *  hand-rolled routes' "set + sweep on write" pattern. */
  set(key: string, value: T): void {
    const now = Date.now();
    this.slots.set(key, { value, expiresAt: now + this.ttlMs, lastAccess: now });
    this.sweepExpired(now);
    this.evictIfNeeded();
  }

  /** Drop a single entry. */
  delete(key: string): void {
    this.slots.delete(key);
  }

  /** Drop everything. */
  clear(): void {
    this.slots.clear();
  }

  /** Alias for `clear()` — HMR/reset hook, mirrors the `dispose()` convention
   *  used by `gitStatusCache`/`efficiencyGradeCache`. Those caches need a
   *  generation counter to guard in-flight async writes; `TtlCache` has no
   *  async operations of its own (get/set are synchronous), so `dispose()`
   *  reduces to a clear. Kept as a distinct method so callers can express
   *  "reset this cache" without reaching for the more generic `clear()`
   *  name, and so a future async extension has an obvious place to add a
   *  generation guard without changing call sites. */
  dispose(): void {
    this.clear();
  }

  private sweepExpired(now: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.expiresAt <= now) this.slots.delete(key);
    }
  }

  /** LRU eviction by `lastAccess`, trimmed to 80% of capacity in one sweep —
   *  same amortization trade-off as `FileCache.evictIfNeeded`: sorting on
   *  every insert near the boundary would be wasteful, so we overshoot the
   *  cut and only re-sort once we're actually over budget. */
  private evictIfNeeded(): void {
    if (this.slots.size <= this.maxEntries) return;
    const target = Math.floor(this.maxEntries * 0.8);
    const entries = Array.from(this.slots.entries()).sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess
    );
    const toEvict = entries.length - target;
    for (let i = 0; i < toEvict; i++) {
      this.slots.delete(entries[i][0]);
    }
  }
}

// Module-level registry, pinned to `globalThis` so named caches survive dev
// HMR reloads the same way each individual hand-rolled cache used to — the
// route module re-executes on every reload, but `getOrCreateRouteCache`
// hands back the SAME instance (and thus the same live entries) rather than
// silently starting a fresh, empty cache each time.
const globalForRouteCaches = globalThis as unknown as {
  __routeCaches?: Map<string, TtlCache<unknown>>;
};

function registry(): Map<string, TtlCache<unknown>> {
  if (!globalForRouteCaches.__routeCaches) {
    globalForRouteCaches.__routeCaches = new Map();
  }
  return globalForRouteCaches.__routeCaches;
}

/**
 * Returns the named route cache, creating it on first call. Subsequent calls
 * with the same `name` — including across HMR module reloads — return the
 * same instance, so its options (`ttlMs`/`maxEntries`) are only honored the
 * first time a given name is created. Route modules should treat `name` as a
 * stable, unique-per-route identifier (e.g. `"agent-network"`).
 */
export function getOrCreateRouteCache<T>(
  name: string,
  opts: Omit<TtlCacheOptions, "name">
): TtlCache<T> {
  const reg = registry();
  const existing = reg.get(name);
  if (existing) return existing as TtlCache<T>;
  const cache = new TtlCache<T>({ ...opts, name });
  reg.set(name, cache as TtlCache<unknown>);
  return cache;
}

/**
 * Clears every named route cache's contents, in place — it does NOT remove
 * them from the registry. Route modules call `getOrCreateRouteCache` exactly
 * once, at module top-level, and keep that reference for the module's
 * lifetime; if this forgot the registry entries, a later
 * `disposeAllRouteCaches()` call would find nothing to clear (the route's
 * own reference would be silently orphaned from the registry, invisible to
 * every subsequent dispose), and any NEW `getOrCreateRouteCache` call for
 * the same name would mint a second, disconnected instance. Clearing
 * in-place preserves identity — the same object route.ts already closed
 * over just becomes empty — the same "reset data, keep the singleton"
 * contract `gitStatusCache.dispose()`/`efficiencyGradeCache.dispose()`
 * honor for their own single, non-registry-backed instances.
 *
 * Dev/HMR + test hygiene hook — nothing in the request path calls this today
 * (same "dormant until wired" status as `gitStatusCache.dispose()`), but it
 * exists so a future hot-reload or feature-flag-flip hook has a single place
 * to reset all route-level caches at once instead of enumerating them by
 * hand.
 */
export function disposeAllRouteCaches(): void {
  for (const cache of registry().values()) cache.dispose();
}
