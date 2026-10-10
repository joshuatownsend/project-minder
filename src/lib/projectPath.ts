import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import type { ProjectData } from "@/lib/types";

/** The scanned projects from the cached scan, scanning and caching if the cache is cold. */
export async function getScannedProjects(): Promise<ProjectData[]> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  return result.projects;
}

/**
 * Resolve a project slug to its absolute path via the cached scan (scanning and
 * caching if the cache is cold). Returns null when no project matches the slug.
 *
 * Shared by the per-project API routes so slug resolution lives in one place.
 */
export async function findProjectPathBySlug(slug: string): Promise<string | null> {
  return (await getScannedProjects()).find((p) => p.slug === slug)?.path ?? null;
}
