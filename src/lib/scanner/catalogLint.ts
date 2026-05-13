import type { MinderConfig, LintFinding, ProjectData } from "../types";
import { getFlag } from "../featureFlags";
import { loadCatalog } from "../indexer/catalog";
import { loadProvenanceContext } from "../indexer/provenance";
import {
  walkUserCommands,
  walkPluginCommands,
  walkProjectCommands,
} from "../indexer/walkCommands";
import { getUserConfig } from "../userConfigCache";
import { runGlobalLint } from "../lint/engine";

/**
 * One-shot global catalog lint — runs once per scan after all projects resolve.
 * Lints user + plugin-scope entries with structural rules, and runs cross-scope
 * duplicate-name/slug checks over the full catalog.
 *
 * Gated by the `configLint` feature flag (same flag as per-project lint).
 * Any failure is non-fatal — returns an empty array.
 */
export async function runCatalogLint(
  projects: ProjectData[],
  flags: MinderConfig["featureFlags"],
): Promise<LintFinding[]> {
  if (!getFlag(flags, "configLint")) return [];

  try {
    const [catalog, ctx, userCfg] = await Promise.all([
      loadCatalog({ includeProjects: true }),
      loadProvenanceContext(),
      getUserConfig().catch(() => null),
    ]);

    // Walk commands across all scopes (loadCatalog doesn't cover commands)
    const [userCommands, pluginCommands, ...projectCommandSets] = await Promise.all([
      walkUserCommands(ctx),
      walkPluginCommands(ctx.installedPlugins, ctx),
      ...projects.map((p) => walkProjectCommands(p.path, p.slug, ctx)),
    ]);
    const allCommands = [userCommands, pluginCommands, ...projectCommandSets].flat();

    return runGlobalLint({
      allSkills: catalog.skills,
      allAgents: catalog.agents,
      allCommands,
      allPlugins: userCfg?.plugins.plugins ?? [],
    });
  } catch {
    return [];
  }
}
