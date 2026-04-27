import { NextRequest, NextResponse } from "next/server";
import { loadCatalog } from "@/lib/indexer/catalog";
import { buildSkillAliasMap } from "@/lib/indexer/canonicalize";
import { parseAllSessions } from "@/lib/usage/parser";
import { groupSkillCalls } from "@/lib/usage/skillParser";
import { getCachedScan } from "@/lib/cache";
import { pathToUsageSlug } from "@/lib/usage/slug";
import type { SkillStats } from "@/lib/usage/types";
import type { SkillEntry } from "@/lib/indexer/types";

const CACHE_TTL_MS = 2 * 60 * 1000;

interface SkillRow {
  entry?: SkillEntry;
  usage?: SkillStats;
  catalogMissing?: boolean;
}

const globalForSkills = globalThis as unknown as {
  __skillsRouteCache?: Map<string, { data: SkillRow[]; cachedAt: number }>;
};

function getRouteCache(key: string): SkillRow[] | null {
  const cache = globalForSkills.__skillsRouteCache;
  if (!cache) return null;
  const slot = cache.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  return null;
}

function setRouteCache(key: string, data: SkillRow[]) {
  if (!globalForSkills.__skillsRouteCache) {
    globalForSkills.__skillsRouteCache = new Map();
  }
  globalForSkills.__skillsRouteCache.set(key, { data, cachedAt: Date.now() });
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

  const allTurns = Array.from(sessionMap.values()).flat();
  const statsArr = groupSkillCalls(allTurns);

  const aliasMap = buildSkillAliasMap(catalog.skills);
  const rows: SkillRow[] = [];
  const matchedNames = new Set<string>();

  for (const entry of catalog.skills) {
    const usage = statsArr.find(
      (s) => aliasMap.get(s.name.toLowerCase()) === entry
    );
    if (usage) matchedNames.add(usage.name);
    rows.push({ entry, usage });
  }

  for (const stat of statsArr) {
    if (!matchedNames.has(stat.name)) {
      rows.push({ usage: stat, catalogMissing: true });
    }
  }

  let result = rows;

  if (source) {
    result = result.filter((r) => r.entry?.source === source || r.catalogMissing);
  }

  if (projectSlug) {
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
