import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtlCache, getOrCreateRouteCache, disposeAllRouteCaches } from "@/lib/routeCache";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  disposeAllRouteCaches();
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("returns undefined for a key that was never set", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("returns the stored value while within the TTL window", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "value-a");
    vi.setSystemTime(999);
    expect(cache.get("a")).toBe("value-a");
  });

  it("expires an entry once its TTL elapses, and deletes it on access", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "value-a");
    vi.setSystemTime(1000); // expiresAt is exclusive: now >= expiresAt means expired
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("sweeps expired entries as a side effect of set()", () => {
    const cache = new TtlCache<string>({ ttlMs: 100 });
    cache.set("a", "v1");
    vi.setSystemTime(200); // "a" now expired
    cache.set("b", "v2");
    // "a" should have been swept during the set() of "b"
    expect(cache.size).toBe(1);
    expect(cache.get("b")).toBe("v2");
  });

  it("overwrites an existing key and refreshes its TTL", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set("a", 1);
    vi.setSystemTime(900);
    cache.set("a", 2); // refresh
    vi.setSystemTime(1800); // 900 + 900 < 900+1000, still fresh relative to refresh
    expect(cache.get("a")).toBe(2);
  });

  it("delete() removes a single entry without affecting others", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "va");
    cache.set("b", "vb");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("vb");
    expect(cache.size).toBe(1);
  });

  it("clear() removes everything", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "va");
    cache.set("b", "vb");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("dispose() is equivalent to clear()", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "va");
    cache.dispose();
    expect(cache.size).toBe(0);
  });

  describe("maxEntries eviction", () => {
    it("evicts the least-recently-used ~20% once over capacity", () => {
      const cache = new TtlCache<string>({ ttlMs: 100_000, maxEntries: 5 });
      for (const k of ["a", "b", "c", "d", "e"]) {
        cache.set(k, k);
        vi.setSystemTime((vi.getMockedSystemTime() as Date).getTime() + 1);
      }
      expect(cache.size).toBe(5);

      // Touch "a" so it's most-recently-used, then insert "f" to overflow.
      cache.get("a");
      vi.setSystemTime((vi.getMockedSystemTime() as Date).getTime() + 1);
      cache.set("f", "f");

      // floor(5 * 0.8) = 4 entries survive the trim.
      expect(cache.size).toBe(4);
      // "a" was freshly touched and "f" was just inserted — both survive.
      expect(cache.get("a")).toBe("a");
      expect(cache.get("f")).toBe("f");
      // The least-recently-used entries ("b", "c") should have been evicted.
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    });

    it("defaults maxEntries to 500", () => {
      const cache = new TtlCache<number>({ ttlMs: 100_000 });
      for (let i = 0; i < 500; i++) cache.set(`k${i}`, i);
      expect(cache.size).toBe(500);
    });

    it("keeps the most-recent entry when maxEntries=1 (never evicts to empty)", () => {
      // Regression: floor(1 * 0.8) = 0 would evict EVERY entry the moment a
      // second key is inserted, leaving the cache permanently empty.
      const cache = new TtlCache<string>({ ttlMs: 100_000, maxEntries: 1 });
      cache.set("a", "a");
      vi.setSystemTime((vi.getMockedSystemTime() as Date).getTime() + 1);
      cache.set("b", "b");
      // The newer key survives; the cache is not wiped.
      expect(cache.size).toBe(1);
      expect(cache.get("b")).toBe("b");
      expect(cache.get("a")).toBeUndefined();
    });
  });
});

describe("getOrCreateRouteCache", () => {
  it("creates a cache on first call and returns the same instance on repeat calls", () => {
    const a = getOrCreateRouteCache<string>("test-cache-1", { ttlMs: 1000 });
    a.set("k", "v");
    const b = getOrCreateRouteCache<string>("test-cache-1", { ttlMs: 1000 });
    expect(b.get("k")).toBe("v");
    expect(a).toBe(b);
  });

  it("simulates HMR reuse: a fresh call with the same name after 'reload' keeps prior entries", () => {
    // First "module load" creates and populates the cache.
    const first = getOrCreateRouteCache<string>("hmr-sim", { ttlMs: 1000 });
    first.set("session-1", "cached-report");

    // A second call with the same name (as would happen when the route
    // module re-executes on HMR) must NOT wipe existing entries — this is
    // the whole point of pinning the registry to globalThis.
    const second = getOrCreateRouteCache<string>("hmr-sim", { ttlMs: 1000 });
    expect(second.get("session-1")).toBe("cached-report");
  });

  it("keeps separate caches isolated by name", () => {
    const a = getOrCreateRouteCache<string>("cache-a", { ttlMs: 1000 });
    const b = getOrCreateRouteCache<string>("cache-b", { ttlMs: 1000 });
    a.set("k", "from-a");
    expect(b.get("k")).toBeUndefined();
  });
});

describe("disposeAllRouteCaches", () => {
  it("clears every registered cache's contents without forgetting the instances", () => {
    const a = getOrCreateRouteCache<string>("dispose-a", { ttlMs: 1000 });
    const b = getOrCreateRouteCache<string>("dispose-b", { ttlMs: 1000 });
    a.set("k", "va");
    b.set("k", "vb");

    disposeAllRouteCaches();

    expect(a.size).toBe(0);
    expect(b.size).toBe(0);

    // A subsequent getOrCreateRouteCache call for the same name gets back
    // the SAME instance (identity preserved) — a route module that captured
    // its cache reference at top-level import time must keep seeing a live,
    // clearable cache across repeated dispose cycles, not an orphaned one.
    const a2 = getOrCreateRouteCache<string>("dispose-a", { ttlMs: 1000 });
    expect(a2).toBe(a);
    expect(a2.get("k")).toBeUndefined();

    // A second dispose cycle must still find and clear it.
    a.set("k2", "va2");
    expect(a.size).toBe(1);
    disposeAllRouteCaches();
    expect(a.size).toBe(0);
  });
});
