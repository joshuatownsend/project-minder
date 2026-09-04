import { walkUserAgents, walkInstalledAgents, walkPluginAgents, walkProjectAgents } from "./walkAgents";
import { walkUserSkills, walkPluginSkills, walkProjectSkills } from "./walkSkills";
import { loadProvenanceContext } from "./provenance";
import { resolveCatalogHome, type CatalogHome } from "./homes";
import { pluginRegistryKey } from "./pluginKey";
import { getCachedScan } from "@/lib/cache";
import { readConfig } from "@/lib/config";
import { checkWslRoot, parseWslUncPath } from "@/lib/wsl";
import type { AgentEntry, CatalogResult, SkillEntry } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * One slot per (home, includeProjects). Before the home dimension (#553)
 * there were exactly two slots; now the primary home still owns two and each
 * other home asked for owns two more. `invalidateCatalogCache` clears them
 * all — a toggle, template apply, or rescan invalidates every home's view
 * rather than reasoning about which one it touched.
 */
const globalForCatalog = globalThis as unknown as {
  __catalogCache?: Map<string, { data: CatalogResult; cachedAt: number }>;
};

function cacheKey(homeKey: string, includeProjects: boolean): string {
  return `${includeProjects ? "p" : "u"}|${homeKey}`;
}

function getCache(key: string): CatalogResult | null {
  const slot = globalForCatalog.__catalogCache?.get(key);
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  return null;
}

function setCache(key: string, data: CatalogResult) {
  if (!globalForCatalog.__catalogCache) globalForCatalog.__catalogCache = new Map();
  globalForCatalog.__catalogCache.set(key, { data, cachedAt: Date.now() });
}

export function invalidateCatalogCache() {
  globalForCatalog.__catalogCache = new Map();
}

/**
 * Deduplicate the two user-agent roots: `~/.claude/agents/` symlink entries
 * win over the same file in `~/.agents/agents/`. Symlinked entries already
 * carry realPath; direct `~/.agents/agents/` entries use filePath as the real
 * path. Whichever appears first in `claudeAgents` claims the slot.
 */
export function mergeUserAgents(claudeAgents: AgentEntry[], installedAgents: AgentEntry[]): AgentEntry[] {
  const seenPaths = new Set<string>(claudeAgents.map((e) => e.realPath ?? e.filePath));
  return [
    ...claudeAgents,
    ...installedAgents.filter((e) => !seenPaths.has(e.realPath ?? e.filePath)),
  ];
}

export interface LoadCatalogOptions {
  includeProjects?: boolean;
  /**
   * Which Claude home's user and plugin entries to walk, by key
   * (`normalizePathKey` of the configured home — a project's
   * `usageHomeKey`). Omit for this machine's own `~/.claude`, which is what
   * every caller got before #553 and what the no-argument form still returns
   * byte-for-byte. See `src/lib/indexer/homes.ts` for why one home per call
   * is the shape, and for the never-wake rule the resolution obeys.
   *
   * @throws CatalogHomeError when the key names no configured home, or one
   *   that cannot be read this cycle.
   */
  home?: string | null;
}

export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<CatalogResult> {
  const includeProjects = opts.includeProjects ?? false;
  const home: CatalogHome = await resolveCatalogHome(opts.home);
  const key = cacheKey(home.key, includeProjects);
  const cached = getCache(key);
  if (cached) return cached;

  // Load provenance context once — shared across all walks
  const ctx = await loadProvenanceContext(home);

  const [claudeAgents, installedAgents, pluginAgents, userSkills, pluginSkills] = await Promise.all([
    walkUserAgents(ctx, home.path),
    walkInstalledAgents(ctx, home.path),
    walkPluginAgents(ctx),
    walkUserSkills(ctx, home.path),
    walkPluginSkills(ctx),
  ]);

  const agents: AgentEntry[] = [...mergeUserAgents(claudeAgents, installedAgents), ...pluginAgents];
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

  const result: CatalogResult = {
    agents,
    skills,
    home: { key: home.key, path: home.path, primary: home.primary },
    // Registry keys (`name@marketplace`), not bare names: two marketplaces can
    // ship the same plugin name, and the key is what `EnvPlugin.id` uses
    // (Copilot on #555).
    unresolvedPlugins: ctx.installedPlugins
      .filter((p) => p.installPathUnresolved)
      .map((p) => pluginRegistryKey(p.pluginName, p.marketplace)),
  };
  if (!includeProjects || hadProjectScan) {
    setCache(key, result);
  }
  return result;
}
