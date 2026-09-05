/**
 * Single-flight by key (#563): concurrent calls for the same key share one
 * in-flight promise instead of each running the work. Introduced so two
 * concurrent `/api/usage` cache misses for the same key run one ~50s report
 * build rather than two — the second awaits the first (which populates the
 * cache) instead of repeating it.
 *
 * The entry is removed once the promise settles (result OR error), so a later
 * request re-runs rather than getting a stale rejected promise. Distinct keys
 * never share.
 */
export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Number of in-flight keys — for tests/diagnostics. */
  size(): number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inflight.get(key);
      if (existing) return existing;
      const p = fn();
      inflight.set(key, p);
      // Clear on settle, either way. Both handlers are provided, so the chained
      // promise never surfaces an unhandled rejection; callers still see `p`'s
      // rejection through the promise returned above.
      void p.then(
        () => inflight.delete(key),
        () => inflight.delete(key)
      );
      return p;
    },
    size() {
      return inflight.size;
    },
  };
}
