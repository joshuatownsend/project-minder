import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";

/**
 * Resolve a project slug to its absolute path via the cached scan (scanning and
 * caching if the cache is cold). Returns null when no project matches the slug.
 *
 * Shared by the per-project API routes so slug resolution lives in one place.
 */
export async function findProjectPathBySlug(slug: string): Promise<string | null> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  return result.projects.find((p) => p.slug === slug)?.path ?? null;
}
