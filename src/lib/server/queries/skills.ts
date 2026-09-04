import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { loadCatalog } from "@/lib/indexer/catalog";
import { resolveCatalogHome } from "@/lib/indexer/homes";
import { buildSkillAliasMap } from "@/lib/indexer/canonicalize";
import { getSkillUsage } from "@/lib/data";
import { getCachedScan } from "@/lib/cache";
import { pathToUsageSlug } from "@/lib/usage/slug";
import { skillUpdateCache, type QueueItem } from "@/lib/skillUpdateCache";
import { getDb } from "@/lib/db/connection";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import type { SkillStats } from "@/lib/usage/types";
import type { SkillEntry, CatalogResult } from "@/lib/indexer/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";
import { demoMode } from "@/lib/demo/demoMode";
import { demoSkills, filterDemoCatalogRows } from "@/lib/demo/catalogs";

/**
 * Shared `/api/skills` response computation — the skills twin of
 * `loadAgentsResponse`, plus the DB invocation-source (slash vs auto)
 * augmentation. Used by both the route and the RSC prefetch so the hydrated
 * cache entry matches a client `fetch('/api/skills')` byte-for-byte.
 */

const CACHE_TTL_MS = 2 * 60 * 1000;

export interface SkillRow {
  entry?: SkillEntry;
  usage?: SkillStats;
  catalogMissing?: boolean;
  slashCount?: number;
  autoCount?: number;
}

interface CacheSlot {
  data: SkillRow[];
  backend: "db" | "file";
  home: CatalogResult["home"];
  unresolvedPlugins: string[];
  cachedAt: number;
}

const globalForSkills = globalThis as unknown as {
  __skillsRouteCache?: Map<string, CacheSlot>;
};

function getRouteCache(key: string): CacheSlot | null {
  const cache = globalForSkills.__skillsRouteCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot;
  return null;
}

function setRouteCache(key: string, slot: Omit<CacheSlot, "cachedAt">) {
  if (!globalForSkills.__skillsRouteCache) {
    globalForSkills.__skillsRouteCache = new Map();
  }
  globalForSkills.__skillsRouteCache.set(key, { ...slot, cachedAt: Date.now() });
}

// `/api/config` resets this slot by name via `src/lib/server/catalogRouteCaches.ts`
// rather than importing this module (DB isolation chain); keep the key in sync.
export function invalidateSkillsRouteCache() {
  globalForSkills.__skillsRouteCache = new Map();
}

function buildUpdateItems(rows: SkillRow[]): QueueItem[] {
  const items: QueueItem[] = [];
  for (const row of rows) {
    if (!row.entry?.provenance) continue;
    const p = row.entry.provenance;
    if (p.kind === "marketplace-plugin" && p.marketplaceRepo && p.gitCommitSha) {
      items.push({ id: row.entry.id, kind: "marketplace-plugin", marketplace: p.marketplace, marketplaceRepo: p.marketplaceRepo, gitCommitSha: p.gitCommitSha });
    } else if (p.kind === "lockfile" && p.sourceUrl && p.skillPath && p.skillFolderHash) {
      items.push({ id: row.entry.id, kind: "lockfile", sourceUrl: p.sourceUrl, skillPath: p.skillPath, skillFolderHash: p.skillFolderHash });
    }
  }
  return items;
}

export interface SkillsResponse {
  data: SkillRow[];
  backend: "db" | "file";
  /** The Claude home the catalog half was walked for. Absent in demo mode. */
  home?: CatalogResult["home"];
  /** Plugins in that home whose contents could not be read from here (see `CatalogResult`). */
  unresolvedPlugins: string[];
}

/** The full `/api/skills` GET body, filter-parameterized. */
export async function loadSkillsResponse(
  source: string | null,
  projectSlug: string | null,
  query: string | null,
  home: string | null = null,
): Promise<SkillsResponse> {
  if (await demoMode()) {
    return {
      data: filterDemoCatalogRows(demoSkills(Date.now()), source, projectSlug, query),
      backend: "file",
      unresolvedPlugins: [],
    };
  }
  const q = query?.toLowerCase() ?? null;
  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${q ?? ""}|${home ?? ""}`;
  // A foreign home is re-resolved BEFORE the cache is consulted: its distro
  // can stop between requests, and a cached 200 would otherwise stand in
  // for the promised 503 until the TTL lapsed (Codex on #555). The primary
  // home short-circuits inside `resolveCatalogHome` at no cost.
  if (home) await resolveCatalogHome(home);
  const cached = getRouteCache(cacheKey);
  if (cached) {
    if (cached.home.primary) skillUpdateCache.enqueue(buildUpdateItems(cached.data));
    return { data: cached.data, backend: cached.backend, home: cached.home, unresolvedPlugins: cached.unresolvedPlugins };
  }

  // Usage joins for the primary home only — see `loadAgentsResponse`.
  const catalog = await loadCatalog({ includeProjects: true, home });
  const skillUsage = catalog.home.primary ? await getSkillUsage() : null;

  const statsArr = skillUsage?.stats ?? [];
  const aliasMap = buildSkillAliasMap(catalog.skills);
  const rows: SkillRow[] = [];
  const matchedNames = new Set<string>();

  for (const entry of catalog.skills) {
    const usage = statsArr.find((s) => aliasMap.get(s.name.toLowerCase()) === entry);
    if (usage) matchedNames.add(usage.name);
    rows.push({ entry: withProjectedContextCost(entry), usage });
  }

  for (const stat of statsArr) {
    if (!matchedNames.has(stat.name)) {
      rows.push({ usage: stat, catalogMissing: true });
    }
  }

  let result = rows;

  if (source) {
    result = result.filter(
      (r) => r.entry?.source === source || (source === "plugin" && r.catalogMissing),
    );
  }

  if (projectSlug) {
    const scan = getCachedScan();
    const project = scan?.projects?.find((p) => p.slug === projectSlug);
    // Prefer the scanner's usageSlug: for a UNC-scanned WSL project it is
    // derived from the MAPPED (Linux-recorded) path, which is how the usage
    // aggregates key WSL-recorded invocations. Recomputing from the raw UNC
    // path here would miss them.
    const usageSlug =
      project?.usageSlug ?? (project?.path ? pathToUsageSlug(project.path) : projectSlug);

    result = result.filter(
      (r) =>
        r.entry?.projectSlug === projectSlug ||
        (r.usage?.projects[usageSlug] ?? 0) > 0 ||
        (r.usage?.projects[projectSlug] ?? 0) > 0,
    );

    if (usageSlug !== projectSlug) {
      result = result.map((r) => {
        if (!r.usage) return r;
        const count = r.usage.projects[usageSlug] ?? 0;
        if (count === 0 || r.usage.projects[projectSlug]) return r;
        return { ...r, usage: { ...r.usage, projects: { ...r.usage.projects, [projectSlug]: count } } };
      });
    }
  }

  if (q) {
    result = result.filter((r) => {
      const text = [r.entry?.name, r.entry?.description, r.entry?.pluginName, r.usage?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(q);
    });
  }

  // Augment with invocation-source breakdown from DB when available. Primary
  // home only, like the usage join: the counts are keyed by skill name with
  // no home dimension.
  try {
    const db = catalog.home.primary ? await getDb() : null;
    if (db) {
      type InvRow = { skill_name: string; invocation_source: string; cnt: number };
      const invRows = db.prepare(
        `SELECT skill_name, invocation_source, COUNT(*) AS cnt
         FROM tool_uses WHERE tool_name = 'Skill' AND skill_name IS NOT NULL
         AND invocation_source IS NOT NULL
         GROUP BY skill_name, invocation_source`,
      ).all() as InvRow[];
      const slashMap = new Map<string, number>();
      const autoMap = new Map<string, number>();
      for (const r of invRows) {
        if (r.invocation_source === "slash_command") slashMap.set(r.skill_name, (slashMap.get(r.skill_name) ?? 0) + r.cnt);
        else autoMap.set(r.skill_name, (autoMap.get(r.skill_name) ?? 0) + r.cnt);
      }
      result = result.map((r) => {
        const name = r.entry?.name ?? r.usage?.name;
        if (!name) return r;
        const slash = slashMap.get(name) ?? 0;
        const auto = autoMap.get(name) ?? 0;
        if (slash === 0 && auto === 0) return r;
        return { ...r, slashCount: slash, autoCount: auto };
      });
    }
  } catch {
    // DB schema not ready (e.g. empty/new DB) — skip invocation-source augmentation
  }

  const backend = skillUsage?.meta.backend ?? "file";
  setRouteCache(cacheKey, { data: result, backend, home: catalog.home, unresolvedPlugins: catalog.unresolvedPlugins });
  // The update checker is process-global and keyed by entry id, which is not
  // home-qualified: a foreign home's copy of the same plugin or lockfile skill
  // would overwrite the primary home's SHA/hash and the main Agents/Skills
  // views would show whichever home was fetched last (Codex on #555). Only
  // this machine's catalog feeds it.
  if (catalog.home.primary) skillUpdateCache.enqueue(buildUpdateItems(result));

  return { data: result, backend, home: catalog.home, unresolvedPlugins: catalog.unresolvedPlugins };
}

/** Prefetch the default (unfiltered) skills catalog (`["skills",null,null,null]`). */
export async function prefetchSkills(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.skills(),
    queryFn: async () => {
      const { data } = await loadSkillsResponse(null, null, null);
      return jsonClone(data);
    },
  });
}
