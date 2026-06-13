import type { MinderConfig, LintFinding, ProjectData } from "../types";
import { getFlag } from "../featureFlags";
import { loadCatalog } from "../indexer/catalog";
import { walkProjectAgents } from "../indexer/walkAgents";
import { walkProjectSkills } from "../indexer/walkSkills";
import {
  walkUserCommands,
  walkPluginCommands,
  walkProjectCommands,
} from "../indexer/walkCommands";
import type { ProvenanceContext } from "../indexer/types";
import { getUserConfig } from "../userConfigCache";
import { runGlobalLint } from "../lint/engine";
import type { ProjectCatalogWalk } from "./index";

/**
 * One-shot global catalog lint — runs once per scan after all projects resolve.
 * Lints user + plugin-scope entries with structural rules, and runs cross-scope
 * duplicate-name/slug checks over the full catalog.
 *
 * Gated by the `configLint` feature flag (same flag as per-project lint).
 * Any failure is non-fatal — returns an empty array.
 *
 * `ctx` is the ProvenanceContext already loaded by `scanAllProjects` — passing
 * it in avoids a second `loadProvenanceContext()` call. `loadCatalog` is called
 * with `includeProjects: false` so we use the fresh `projects` argument for
 * project-scope entries instead of the stale getCachedScan() snapshot.
 */
export async function runCatalogLint(
  projects: ProjectData[],
  flags: MinderConfig["featureFlags"],
  ctx: ProvenanceContext,
  catalogWalkBySlug?: Map<string, ProjectCatalogWalk>,
): Promise<LintFinding[]> {
  if (!getFlag(flags, "configLint")) return [];

  try {
    const [baseCatalog, userCfg] = await Promise.all([
      loadCatalog({ includeProjects: false }),
      getUserConfig().catch(() => null),
    ]);

    // Walk project-scope agents/skills from the fresh scan instead of relying
    // on the stale getCachedScan() snapshot that loadCatalog(includeProjects:true) uses.
    // When the side-channel map is present, reuse entries already computed by
    // scanProject — avoids ~60 redundant traversals on a full scan.
    const projectEntryResults = await Promise.all(
      projects.map(async (p) => {
        const pre = catalogWalkBySlug?.get(p.slug);
        if (pre) return { skills: pre.skills, agents: pre.agents };
        const [pSkills, pAgents] = await Promise.all([
          walkProjectSkills(p.path, p.slug, ctx),
          walkProjectAgents(p.path, p.slug, ctx),
        ]);
        return { skills: pSkills, agents: pAgents };
      })
    );

    // Walk commands across all scopes (loadCatalog doesn't cover commands).
    // Project-scope commands also reuse the side-channel map when available.
    const projectCommandSets = await Promise.all(
      projects.map((p) => {
        const pre = catalogWalkBySlug?.get(p.slug);
        return pre ? Promise.resolve(pre.commands) : walkProjectCommands(p.path, p.slug, ctx);
      })
    );
    const [userCommands, pluginCommands] = await Promise.all([
      walkUserCommands(ctx),
      walkPluginCommands(ctx.installedPlugins, ctx),
    ]);
    const allCommands = [userCommands, pluginCommands, ...projectCommandSets].flat();

    return runGlobalLint({
      allSkills: [...baseCatalog.skills, ...projectEntryResults.flatMap((e) => e.skills)],
      allAgents: [...baseCatalog.agents, ...projectEntryResults.flatMap((e) => e.agents)],
      allCommands,
      allPlugins: userCfg?.plugins.plugins ?? [],
    });
  } catch {
    return [];
  }
}
