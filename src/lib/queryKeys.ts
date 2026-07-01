/**
 * Centralized TanStack Query key factory.
 *
 * Every `useQuery`/`useMutation`/`invalidateQueries` call references keys
 * through this object rather than inlining string arrays, so that:
 *   - keys stay consistent across hooks, prefetch (PR 2), and SSE-driven
 *     invalidation (PR 5);
 *   - param order/namespacing is defined in exactly one place;
 *   - the shapes are unit-testable as pure functions (no React, no DOM).
 *
 * Keys are namespaced by resource, then by `"list"` vs `"detail"` where a
 * resource has both, so a detail key can never collide with a list key that
 * happens to share a leading segment (e.g. `["insights", "<slug>"]` vs a
 * project-filtered list `["insights", "<slug>", undefined]`).
 *
 * `undefined`/optional params are normalized to `null` so that `useUsage("week")`
 * and `useUsage("week", undefined)` resolve to the *same* cache entry.
 */
export const queryKeys = {
  sessions: {
    all: () => ["sessions", "list"] as const,
    detail: (sessionId: string) => ["sessions", "detail", sessionId] as const,
  },
  stats: () => ["stats"] as const,
  usage: (period: string, project?: string) =>
    ["usage", period, project ?? null] as const,
  agents: (source?: string, project?: string, query?: string) =>
    ["agents", source ?? null, project ?? null, query ?? null] as const,
  skills: (source?: string, project?: string, query?: string) =>
    ["skills", source ?? null, project ?? null, query ?? null] as const,
  insights: {
    all: (project?: string, query?: string) =>
      ["insights", "list", project ?? null, query ?? null] as const,
    detail: (slug: string) => ["insights", "detail", slug] as const,
  },
  commands: (source?: string, project?: string, query?: string) =>
    ["commands", source ?? null, project ?? null, query ?? null] as const,
  templates: () => ["templates"] as const,
  manualSteps: () => ["manual-steps", "list"] as const,
  // Config catalog is per-tab: `type` is the catalog tab (hooks/mcp/cicd/…).
  // The settings/playground tabs don't fetch, so they never produce a key.
  config: (type: string, project?: string, query?: string) =>
    ["config", type, project ?? null, query ?? null] as const,
} as const;
