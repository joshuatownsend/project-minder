import { walkUserAgents, walkInstalledAgents, walkPluginAgents, walkProjectAgents } from "./walkAgents";
import { walkUserSkills, walkPluginSkills, walkProjectSkills } from "./walkSkills";
import { loadProvenanceContext } from "./provenance";
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

  // Load provenance context once — shared across all walks
  const ctx = await loadProvenanceContext();

  const [claudeAgents, installedAgents, pluginAgents, userSkills, pluginSkills] = await Promise.all([
    walkUserAgents(ctx),
    walkInstalledAgents(ctx),
    walkPluginAgents(ctx),
    walkUserSkills(ctx),
    walkPluginSkills(ctx),
  ]);

  // Deduplicate: ~/.claude/agents/ symlink entries win over the same file in ~/.agents/agents/.
  // Symlinked entries already carry realPath; direct ~/.agents/agents/ entries use filePath as
  // the real path. Whichever appears first in claudeAgents claims the slot.
  const seenPaths = new Set<string>(claudeAgents.map((e) => e.realPath ?? e.filePath));
  const mergedUserAgents = [
    ...claudeAgents,
    ...installedAgents.filter((e) => !seenPaths.has(e.realPath ?? e.filePath)),
  ];

  const agents: AgentEntry[] = [...mergedUserAgents, ...pluginAgents];
  const skills: SkillEntry[] = [...userSkills, ...pluginSkills];

  let hadProjectScan = false;
  if (includeProjects) {
    const scan = getCachedScan();
    const projects = scan?.projects ?? [];
    hadProjectScan = projects.length > 0;

    await Promise.all(
      projects.map(async (project) => {
        const [pAgents, pSkills] = await Promise.all([
          walkProjectAgents(project.path, project.slug, ctx),
          walkProjectSkills(project.path, project.slug, ctx),
        ]);
        agents.push(...pAgents);
        skills.push(...pSkills);
      })
    );
  }

  const result: CatalogResult = { agents, skills };
  if (!includeProjects || hadProjectScan) {
    setCache(includeProjects, result);
  }
  return result;
}
