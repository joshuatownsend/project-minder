import path from "path";
import type { Provenance, ProvenanceContext } from "./types";
import type { CatalogHome } from "./homes";
import { loadInstalledPlugins } from "./walkPlugins";
import { loadLockfile } from "./walkLockfile";
import { loadKnownMarketplaces } from "./marketplaces";

export function resolveProvenance(opts: {
  source: "user" | "plugin" | "project";
  entryKind: "skill" | "agent" | "command";
  slug: string;
  isSymlink?: boolean;
  realPath?: string;
  pluginName?: string;
  projectSlug?: string;
  ctx: ProvenanceContext;
}): Provenance {
  const { source, entryKind, slug, isSymlink, realPath, pluginName, projectSlug, ctx } = opts;

  if (source === "project" && projectSlug) {
    return { kind: "project-local", projectSlug };
  }

  if (source === "plugin" && pluginName) {
    const plugin = ctx.installedPlugins.find((p) => p.pluginName === pluginName);
    if (plugin) {
      return {
        kind: "marketplace-plugin",
        pluginName: plugin.pluginName,
        marketplace: plugin.marketplace,
        marketplaceRepo: ctx.marketplaceRepo.get(plugin.marketplace),
        pluginVersion:
          plugin.version && plugin.version !== "unknown" ? plugin.version : undefined,
        gitCommitSha: plugin.gitCommitSha,
        installedAt: plugin.installedAt,
        lastUpdated: plugin.lastUpdated,
        pluginRepoUrl: plugin.pluginRepoUrl,
      };
    }
  }

  if (source === "user" && entryKind === "skill") {
    let lockEntry = ctx.lockfile.get(slug);

    // For bundled symlinks: the lockfile key is the parent dir name of the realPath
    if (!lockEntry && isSymlink && realPath) {
      const parentSlug = path.basename(path.dirname(realPath));
      if (parentSlug !== slug) {
        lockEntry = ctx.lockfile.get(parentSlug);
      }
    }

    if (lockEntry) {
      return {
        kind: "lockfile",
        source: lockEntry.source,
        sourceType: lockEntry.sourceType,
        sourceUrl: lockEntry.sourceUrl,
        skillPath: lockEntry.skillPath,
        skillFolderHash: lockEntry.skillFolderHash,
        installedAt: lockEntry.installedAt,
        updatedAt: lockEntry.updatedAt,
        symlinkTarget: realPath,
      };
    }
  }

  return { kind: "user-local" };
}

/**
 * Provenance inputs for one Claude home: its plugin registry, the skills
 * lockfile beside it, and its known marketplaces. No argument means this
 * machine's `~/.claude`, exactly as before the home dimension (#553).
 */
export async function loadProvenanceContext(home?: CatalogHome): Promise<ProvenanceContext> {
  const [installedPlugins, lockfile, marketplaceRepo] = await Promise.all([
    loadInstalledPlugins(home),
    loadLockfile(home?.path),
    loadKnownMarketplaces(home?.path),
  ]);
  return {
    installedPlugins,
    lockfile,
    marketplaceRepo,
    ...(home ? { homeKey: home.key } : {}),
  };
}
