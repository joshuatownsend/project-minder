import type { MinderEventType } from "./types";

/**
 * Map a live event → the TanStack Query cache keys to invalidate (Performance
 * P3 — PR 5a). Client-safe and pure so it can be unit-tested and imported by
 * the browser SSE bridge.
 *
 * Returns *prefix* keys, not full keys: TanStack matches `invalidateQueries`
 * by key prefix, so `["sessions"]` invalidates the list AND every
 * `["sessions", "detail", id]` in one call. Only prefixes that correspond to a
 * real `queryKeys` factory entry are returned — invalidating a key no page uses
 * is a harmless no-op, but keeping the map tight documents the intent.
 *
 * `invalidateQueries` only *refetches* queries that are currently mounted, so
 * an event that maps to a page the user isn't viewing costs nothing.
 */
export function eventToQueryPrefixes(type: MinderEventType): readonly (readonly string[])[] {
  switch (type) {
    case "sessions.changed":
      // The live sessions list + any open session detail.
      return [["sessions"]];
    case "scan.invalidated":
      // Resources derived from the project scan cache.
      return [["insights"], ["stats"], ["manual-steps"]];
  }
}
