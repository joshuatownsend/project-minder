import { walkUserAgents, walkInstalledAgents, walkPluginAgents, walkProjectAgents } from "./walkAgents";
import { walkUserSkills, walkPluginSkills, walkProjectSkills } from "./walkSkills";
import { loadProvenanceContext } from "./provenance";
import { getCachedScan } from "@/lib/cache";
import { readConfig } from "@/lib/config";
import { checkWslRoot, parseWslUncPath } from "@/lib/wsl";
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

    // Walk projects in batches (same batch size the scanner uses for its own
    // project fan-out — `config.scanBatchSize`, default 10) instead of one
    // unbounded `Promise.all` over every project. At ~61 projects an
    // unbounded fan-out opens that many directory walks concurrently and
    // puts real pressure on the OS's open-fd limit; batching bounds
    // concurrency to the same figure the scanner already tunes. Results are
    // collected per-batch and flattened in project order, so output ordering
    // is deterministic (an improvement over the prior unbounded fan-out,
    // whose push order depended on filesystem completion timing).
    const config = await readConfig();
    const batchSize = Math.max(1, Math.round(config.scanBatchSize ?? 10));

    for (let i = 0; i < projects.length; i += batchSize) {
      const batch = projects.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (project) => {
          // Never-wake preflight: carried-forward projects under a stopped
          // WSL distro sit in the scan cache like any other project, and
          // walking their agents/skills dirs over \\wsl.localhost would
          // auto-start the VM. Contribute nothing for the cycle instead
          // (checkWslRoot's own cache makes the per-project call cheap).
          if (parseWslUncPath(project.path)) {
            const wslCheck = await checkWslRoot(project.path);
            if (wslCheck && !wslCheck.ok) {
              return { pAgents: [], pSkills: [] };
            }
          }
          const [pAgents, pSkills] = await Promise.all([
            walkProjectAgents(project.path, project.slug, ctx),
            walkProjectSkills(project.path, project.slug, ctx),
          ]);
          return { pAgents, pSkills };
        })
      );
      for (const { pAgents, pSkills } of batchResults) {
        agents.push(...pAgents);
        skills.push(...pSkills);
      }
    }
  }

  const result: CatalogResult = { agents, skills };
  if (!includeProjects || hadProjectScan) {
    setCache(includeProjects, result);
  }
  return result;
}
