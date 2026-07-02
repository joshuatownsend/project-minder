/**
 * The event contract shared by the server event bus and the client SSE bridge
 * (Performance P3 — PR 5a). Deliberately client-safe (no `server-only`, no
 * Node imports) so both `@/lib/events/bus` (server) and the browser bridge can
 * import the same union.
 *
 * Events are intentionally coarse: each names a *class of data that changed*,
 * not a specific record. The client maps the type → the TanStack Query cache
 * keys to invalidate (see `@/lib/events/invalidation`), so a single event can
 * refresh several pages without the server knowing anything about the cache.
 */
export const MINDER_EVENT_TYPES = [
  /** A session's turns/tool-uses were (re-)ingested into the index. */
  "sessions.changed",
  /**
   * The derived scan cache was invalidated — the single choke point
   * (`invalidateCache`) fired by every scan-mutating path (rescans, board /
   * config / todo writes, manual-step toggles, the MANUAL_STEPS watcher). So
   * this one event covers manual-steps, insights, and stats; there is
   * deliberately no separate `manual-steps.changed`.
   */
  "scan.invalidated",
  /**
   * The background git-dirty-status cache stored a fresh batch of results.
   * Consumed by `useGitDirtyStatus` (a non-Query hook), not the query cache, so
   * it maps to no query key — see `@/lib/events/invalidation`.
   */
  "git-status.updated",
  /** The background GitHub-activity cache stored a fresh batch of results. */
  "github-activity.updated",
] as const;

export type MinderEventType = (typeof MINDER_EVENT_TYPES)[number];

export interface MinderEvent {
  type: MinderEventType;
}
