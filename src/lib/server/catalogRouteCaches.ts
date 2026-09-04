/**
 * Clear the `/api/agents` and `/api/skills` response caches without importing
 * the query modules that own them.
 *
 * Those modules (`src/lib/server/queries/agents.ts`, `skills.ts`) export their
 * own `invalidate*RouteCache`, and every caller that already depends on them
 * should keep using those. This exists for `/api/config`, which must clear the
 * caches on a `claudeHomes` / `pathMappings` write (#553) but sits on a chain
 * the DB isolation convention keeps away from `src/lib/data` — importing the
 * query modules there drags `src/lib/db/connection.ts` into two route tests
 * (`tests/dbIsolationGuard.test.ts`). The slots are `globalThis` maps by
 * design (they survive Next's module reloads), so resetting them by name is
 * exactly what the owning invalidators do.
 */
export function invalidateCatalogRouteCaches(): void {
  const g = globalThis as unknown as { __agentsRouteCache?: Map<string, unknown>; __skillsRouteCache?: Map<string, unknown> };
  g.__agentsRouteCache = new Map();
  g.__skillsRouteCache = new Map();
}
