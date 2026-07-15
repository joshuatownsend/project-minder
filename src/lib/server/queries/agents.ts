import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { loadCatalog } from "@/lib/indexer/catalog";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";
import { getAgentUsage } from "@/lib/data";
import { getCachedScan } from "@/lib/cache";
import { pathToUsageSlug } from "@/lib/usage/slug";
import { skillUpdateCache, type QueueItem } from "@/lib/skillUpdateCache";
import { withProjectedContextCost } from "@/lib/usage/tokenEstimate";
import type { AgentStats } from "@/lib/usage/types";
import type { AgentEntry } from "@/lib/indexer/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";
import { demoMode } from "@/lib/demo/demoMode";
import { demoAgents, filterDemoCatalogRows } from "@/lib/demo/catalogs";

/**
 * Shared `/api/agents` response computation, used by BOTH the route (client
 * fetch) and the RSC prefetch. `loadAgentsResponse` is the entire GET body —
 * cache check, catalog/usage join, filter, cache write, and the
 * `skillUpdateCache` enqueue side-effect — parameterized by the three filters.
 * The route wraps it in an HTTP response; the prefetch calls it with no filters
 * and JSON-clones the result, so the hydrated cache entry is byte-identical to
 * a client `fetch('/api/agents')`.
 */

const CACHE_TTL_MS = 2 * 60 * 1000;

export interface AgentRow {
  entry?: AgentEntry;
  usage?: AgentStats;
  catalogMissing?: boolean;
}

interface CacheSlot {
  data: AgentRow[];
  backend: "db" | "file";
  cachedAt: number;
}

const globalForAgents = globalThis as unknown as {
  __agentsRouteCache?: Map<string, CacheSlot>;
};

function getRouteCache(key: string): CacheSlot | null {
  const cache = globalForAgents.__agentsRouteCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot;
  return null;
}

function setRouteCache(key: string, data: AgentRow[], backend: "db" | "file") {
  if (!globalForAgents.__agentsRouteCache) {
    globalForAgents.__agentsRouteCache = new Map();
  }
  globalForAgents.__agentsRouteCache.set(key, { data, backend, cachedAt: Date.now() });
}

export function invalidateAgentsRouteCache() {
  globalForAgents.__agentsRouteCache = new Map();
}

function buildUpdateItems(rows: AgentRow[]): QueueItem[] {
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

export interface AgentsResponse {
  data: AgentRow[];
  backend: "db" | "file";
}

/** The full `/api/agents` GET body, filter-parameterized. */
export async function loadAgentsResponse(
  source: string | null,
  projectSlug: string | null,
  query: string | null,
): Promise<AgentsResponse> {
  if (await demoMode()) {
    return { data: filterDemoCatalogRows(demoAgents(Date.now()), source, projectSlug, query), backend: "file" };
  }
  const q = query?.toLowerCase() ?? null;
  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${q ?? ""}`;
  const cached = getRouteCache(cacheKey);
  if (cached) {
    skillUpdateCache.enqueue(buildUpdateItems(cached.data));
    return { data: cached.data, backend: cached.backend };
  }

  const [catalog, agentUsage] = await Promise.all([
    loadCatalog({ includeProjects: true }),
    getAgentUsage(),
  ]);

  const statsArr = agentUsage.stats;
  const aliasMap = buildAgentAliasMap(catalog.agents);
  const rows: AgentRow[] = [];
  const matchedNames = new Set<string>();

  for (const entry of catalog.agents) {
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
    // catalogMissing rows are orphan invocations — treat as plugin-origin only
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

    // Normalize: expose the count under the scanner slug so components don't
    // need to know about the usage slug format.
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
      const text = [r.entry?.name, r.entry?.description, r.entry?.category, r.entry?.pluginName, r.usage?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(q);
    });
  }

  setRouteCache(cacheKey, result, agentUsage.meta.backend);
  skillUpdateCache.enqueue(buildUpdateItems(result));

  return { data: result, backend: agentUsage.meta.backend };
}

/** Prefetch the default (unfiltered) agents catalog (`["agents",null,null,null]`). */
export async function prefetchAgents(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.agents(),
    queryFn: async () => {
      const { data } = await loadAgentsResponse(null, null, null);
      return jsonClone(data);
    },
  });
}
