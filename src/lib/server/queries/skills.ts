import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { loadCatalog } from "@/lib/indexer/catalog";
import { buildSkillAliasMap } from "@/lib/indexer/canonicalize";
import { getSkillUsage } from "@/lib/data";
import { getCachedScan } from "@/lib/cache";
import { pathToUsageSlug } from "@/lib/usage/slug";
import { skillUpdateCache, type QueueItem } from "@/lib/skillUpdateCache";
import { getDb } from "@/lib/db/connection";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import type { SkillStats } from "@/lib/usage/types";
import type { SkillEntry } from "@/lib/indexer/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";
import { demoMode } from "@/lib/demo/demoMode";
import { demoSkills } from "@/lib/demo/catalogs";

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

function setRouteCache(key: string, data: SkillRow[], backend: "db" | "file") {
  if (!globalForSkills.__skillsRouteCache) {
    globalForSkills.__skillsRouteCache = new Map();
  }
  globalForSkills.__skillsRouteCache.set(key, { data, backend, cachedAt: Date.now() });
}

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
}

/** The full `/api/skills` GET body, filter-parameterized. */
export async function loadSkillsResponse(
  source: string | null,
  projectSlug: string | null,
  query: string | null,
): Promise<SkillsResponse> {
  if (await demoMode()) return { data: demoSkills(Date.now()), backend: "file" };
  const q = query?.toLowerCase() ?? null;
  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${q ?? ""}`;
  const cached = getRouteCache(cacheKey);
  if (cached) {
    skillUpdateCache.enqueue(buildUpdateItems(cached.data));
    return { data: cached.data, backend: cached.backend };
  }

  const [catalog, skillUsage] = await Promise.all([
    loadCatalog({ includeProjects: true }),
    getSkillUsage(),
  ]);

  const statsArr = skillUsage.stats;
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
    const projectPath = scan?.projects?.find((p) => p.slug === projectSlug)?.path;
    const usageSlug = projectPath ? pathToUsageSlug(projectPath) : projectSlug;

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

  // Augment with invocation-source breakdown from DB when available.
  try {
    const db = await getDb();
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

  setRouteCache(cacheKey, result, skillUsage.meta.backend);
  skillUpdateCache.enqueue(buildUpdateItems(result));

  return { data: result, backend: skillUsage.meta.backend };
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
