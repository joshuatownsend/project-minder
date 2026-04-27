import { walkUserAgents, walkPluginAgents, walkProjectAgents } from "./walkAgents";
import { walkUserSkills, walkPluginSkills, walkProjectSkills } from "./walkSkills";
import { getCachedScan } from "@/lib/cache";
import type { AgentEntry, CatalogResult, SkillEntry } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

const globalForCatalog = globalThis as unknown as {
  __catalogCache?: {
    withProjects: { data: CatalogResult; cachedAt: number } | null;
    withoutProjects: { data: CatalogResult; cachedAt: number } | null;
  };
};

function getCache(includeProjects: boolean) {
  if (!globalForCatalog.__catalogCache) return null;
  const slot = includeProjects
    ? globalForCatalog.__catalogCache.withProjects
    : globalForCatalog.__catalogCache.withoutProjects;
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  return null;
}

function setCache(includeProjects: boolean, data: CatalogResult) {
  if (!globalForCatalog.__catalogCache) {
    globalForCatalog.__catalogCache = { withProjects: null, withoutProjects: null };
  }
  const slot = { data, cachedAt: Date.now() };
  if (includeProjects) {
    globalForCatalog.__catalogCache.withProjects = slot;
  } else {
    globalForCatalog.__catalogCache.withoutProjects = slot;
  }
}

export function invalidateCatalogCache() {
  globalForCatalog.__catalogCache = { withProjects: null, withoutProjects: null };
}

export async function loadCatalog(
  opts: { includeProjects?: boolean } = {}
): Promise<CatalogResult> {
  const includeProjects = opts.includeProjects ?? false;
  const cached = getCache(includeProjects);
  if (cached) return cached;

  const [userAgents, pluginAgents, userSkills, pluginSkills] = await Promise.all([
    walkUserAgents(),
    walkPluginAgents(),
    walkUserSkills(),
    walkPluginSkills(),
  ]);

  const agents: AgentEntry[] = [...userAgents, ...pluginAgents];
  const skills: SkillEntry[] = [...userSkills, ...pluginSkills];

  let hadProjectScan = false;
  if (includeProjects) {
    const scan = getCachedScan();
    const projects = scan?.projects ?? [];
    hadProjectScan = projects.length > 0;

    await Promise.all(
      projects.map(async (project) => {
        const [pAgents, pSkills] = await Promise.all([
          walkProjectAgents(project.path, project.slug),
          walkProjectSkills(project.path, project.slug),
        ]);
        agents.push(...pAgents);
        skills.push(...pSkills);
      })
    );
  }

  const result: CatalogResult = { agents, skills };
  // Don't cache the withProjects slot if the scan cache was empty — let the
  // next request retry once the scan has run.
  if (!includeProjects || hadProjectScan) {
    setCache(includeProjects, result);
  }
  return result;
}
