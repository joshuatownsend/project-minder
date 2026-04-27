import path from "path";
import type { Provenance, ProvenanceContext } from "./types";
import { loadInstalledPlugins } from "./walkPlugins";
import { loadLockfile } from "./walkLockfile";
import { loadKnownMarketplaces } from "./marketplaces";

export function resolveProvenance(opts: {
  source: "user" | "plugin" | "project";
  slug: string;
  isSymlink?: boolean;
  realPath?: string;
  pluginName?: string;
  projectSlug?: string;
  ctx: ProvenanceContext;
}): Provenance {
  const { source, slug, isSymlink, realPath, pluginName, projectSlug, ctx } = opts;

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

  if (source === "user") {
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

export async function loadProvenanceContext(): Promise<ProvenanceContext> {
  const [installedPlugins, lockfile, marketplaceRepo] = await Promise.all([
    loadInstalledPlugins(),
    loadLockfile(),
    loadKnownMarketplaces(),
  ]);
  return { installedPlugins, lockfile, marketplaceRepo };
}
