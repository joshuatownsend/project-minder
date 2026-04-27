import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/lib/indexer/catalog";
import { buildAgentAliasMap } from "@/lib/indexer/canonicalize";
import { parseAllSessions } from "@/lib/usage/parser";
import { groupAgentCalls } from "@/lib/usage/agentParser";
import { getCachedScan } from "@/lib/cache";
import { pathToUsageSlug } from "@/lib/usage/slug";
import type { AgentStats } from "@/lib/usage/types";
import type { AgentEntry } from "@/lib/indexer/types";

const CACHE_TTL_MS = 2 * 60 * 1000;

interface AgentRow {
  entry?: AgentEntry;
  usage?: AgentStats;
  catalogMissing?: boolean;
}

const globalForAgents = globalThis as unknown as {
  __agentsRouteCache?: Map<string, { data: AgentRow[]; cachedAt: number }>;
};

function getRouteCache(key: string): AgentRow[] | null {
  const cache = globalForAgents.__agentsRouteCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  return null;
}

function setRouteCache(key: string, data: AgentRow[]) {
  if (!globalForAgents.__agentsRouteCache) {
    globalForAgents.__agentsRouteCache = new Map();
  }
  globalForAgents.__agentsRouteCache.set(key, { data, cachedAt: Date.now() });
}

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source");
  const projectSlug = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q")?.toLowerCase();

  const cacheKey = `${source ?? ""}|${projectSlug ?? ""}|${query ?? ""}`;
  const cached = getRouteCache(cacheKey);
  if (cached) return NextResponse.json(cached);

  const [catalog, sessionMap] = await Promise.all([
    loadCatalog({ includeProjects: true }),
    parseAllSessions(),
  ]);

  // Flatten all turns
  const allTurns = Array.from(sessionMap.values()).flat();
  const statsArr = groupAgentCalls(allTurns);

  const aliasMap = buildAgentAliasMap(catalog.agents);
  const rows: AgentRow[] = [];
  const matchedNames = new Set<string>();

  // Emit catalog entries, attach usage if available
  for (const entry of catalog.agents) {
    const usage = statsArr.find(
      (s) => aliasMap.get(s.name.toLowerCase()) === entry
    );
    if (usage) matchedNames.add(usage.name);
    rows.push({ entry, usage });
  }

  // Orphan stats: invoked names not matched to any catalog entry
  for (const stat of statsArr) {
    if (!matchedNames.has(stat.name)) {
      rows.push({ usage: stat, catalogMissing: true });
    }
  }

  // Apply filters
  let result = rows;

  if (source) {
    result = result.filter((r) => r.entry?.source === source || r.catalogMissing);
  }

  if (projectSlug) {
    // The usage module stores project keys in the encoded path format
    // (e.g. "c--dev-project-minder") while the scanner uses the short
    // directory-basename form ("project-minder"). Look up the project path
    // and compute the matching usage slug so "Invoked here" works correctly.
    const scan = getCachedScan();
    const projectPath = scan?.projects?.find((p) => p.slug === projectSlug)?.path;
    const usageSlug = projectPath ? pathToUsageSlug(projectPath) : projectSlug;

    result = result.filter(
      (r) =>
        r.entry?.projectSlug === projectSlug ||
        (r.usage?.projects[usageSlug] ?? 0) > 0 ||
        (r.usage?.projects[projectSlug] ?? 0) > 0
    );
  }

  if (query) {
    result = result.filter((r) => {
      const text = [
        r.entry?.name,
        r.entry?.description,
        r.entry?.category,
        r.entry?.pluginName,
        r.usage?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(query);
    });
  }

  setRouteCache(cacheKey, result);
  return NextResponse.json(result);
}
