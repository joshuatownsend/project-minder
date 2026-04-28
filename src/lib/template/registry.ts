import { promises as fs } from "fs";
import { MinderConfig, TemplateManifest } from "../types";
import {
  isValidSlug,
  manifestPathForSlug,
  readManifest,
  templatesRootForConfig,
} from "./manifest";

/**
 * Lists every valid template manifest under `<devRoot>/.minder/templates/`.
 * Skips directories whose name isn't a valid slug, manifests that fail to
 * parse, and manifests that fail validation. Errors are returned alongside so
 * the UI can warn rather than swallow.
 */
export async function listTemplates(config: MinderConfig): Promise<{
  manifests: TemplateManifest[];
  errors: Array<{ slug: string; reason: string }>;
}> {
  const root = templatesRootForConfig(config);
  const manifests: TemplateManifest[] = [];
  const errors: Array<{ slug: string; reason: string }> = [];

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // Templates root doesn't exist yet — that's the empty-state, not an error.
    return { manifests, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (!isValidSlug(slug)) continue;

    try {
      const result = await readManifest(config, slug);
      if (!result) {
        errors.push({ slug, reason: "no template.json" });
        continue;
      }
      if ("errors" in result) {
        errors.push({
          slug,
          reason: result.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
        });
        continue;
      }
      manifests.push(result.manifest);
    } catch (e) {
      errors.push({ slug, reason: (e as Error).message });
    }
  }

  // Stable order: most recently updated first.
  manifests.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));

  return { manifests, errors };
}

/** Convenience: does a manifest with this slug already exist? */
export async function templateExists(config: MinderConfig, slug: string): Promise<boolean> {
  try {
    await fs.access(manifestPathForSlug(config, slug));
    return true;
  } catch {
    return false;
  }
}
