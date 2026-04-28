import {
  MinderConfig,
  ScanResult,
  TemplateManifest,
} from "../types";
import { bundleDirForSlug } from "./manifest";
import { fileExists } from "./atomicFs";

/**
 * Returns the virtual project root path from which the apply layer should
 * read this template's source content.
 *
 *  - kind === "snapshot": `<devRoot>/.minder/templates/<slug>/bundle/`
 *    (a directory mirroring a real project's `.claude/` + `.mcp.json`)
 *  - kind === "live": the live source project's filesystem path
 *    (looked up via the cached scan)
 *
 * `findHookByKey`, `walkProjectAgents`, etc. all happily walk either kind
 * because both layouts match a real project's `.claude/` structure.
 */
export async function resolveTemplateSourcePath(
  manifest: TemplateManifest,
  config: MinderConfig,
  scan: ScanResult
): Promise<{ path: string } | { error: { code: string; message: string } }> {
  if (manifest.kind === "snapshot") {
    const bundle = bundleDirForSlug(config, manifest.slug);
    if (!(await fileExists(bundle))) {
      return {
        error: {
          code: "MISSING_BUNDLE",
          message: `Snapshot bundle not found at ${bundle}.`,
        },
      };
    }
    return { path: bundle };
  }

  // kind === "live"
  if (!manifest.liveSourceSlug) {
    return {
      error: {
        code: "INVALID_LIVE_MANIFEST",
        message: `Live template "${manifest.slug}" has no liveSourceSlug.`,
      },
    };
  }
  const sourceProject = scan.projects.find((p) => p.slug === manifest.liveSourceSlug);
  if (!sourceProject) {
    return {
      error: {
        code: "LIVE_SOURCE_MISSING",
        message: `Live source project "${manifest.liveSourceSlug}" no longer exists in any devRoot.`,
      },
    };
  }
  return { path: sourceProject.path };
}
