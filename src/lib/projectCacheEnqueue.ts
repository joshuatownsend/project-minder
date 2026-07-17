import { gitStatusCache } from "@/lib/gitStatusCache";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { getFlag } from "@/lib/featureFlags";
import type { MinderConfig } from "@/lib/types";

/** Structural subset of `ProjectData` this helper needs — kept minimal so
 *  both `/api/projects` (full `ProjectData[]`) and boot-time bootstrap
 *  (`src/lib/bootstrap.ts`, working off a fresh `scanAllProjects()` result)
 *  can call it without extra mapping. */
export interface EnqueueableProject {
  slug: string;
  path: string;
  git?: { isDirty: boolean; uncommittedCount: number; unknown?: boolean; remoteUrl?: string };
  claude?: { sessionCount: number };
}

/**
 * Shared enqueue logic for the background git-status / efficiency-grade /
 * GitHub-activity caches. Extracted from `/api/projects`'s `enrichAndEnqueue`
 * (Wave: service-mode A1) so boot-time bootstrap can warm the same caches on
 * server start without duplicating the enqueue rules — both call sites must
 * stay in lockstep with each other by construction, not by convention.
 *
 * Mutates `p.git` in place with any already-cached dirty status (matches the
 * pre-extraction behavior); this is a no-op the first time it runs against a
 * freshly-scanned project list, since `gitStatusCache` starts empty.
 */
export function enqueueProjectCaches(
  projects: EnqueueableProject[],
  flags: MinderConfig["featureFlags"]
): void {
  const toEnqueueGit: { slug: string; path: string }[] = [];
  const toEnqueueGrade: { slug: string; path: string; hasSessions: boolean }[] = [];

  for (const p of projects) {
    if (p.git) {
      const cached = gitStatusCache.get(p.slug);
      if (cached) {
        p.git.isDirty = cached.isDirty;
        p.git.uncommittedCount = cached.uncommittedCount;
        p.git.unknown = cached.unknown;
      } else {
        toEnqueueGit.push({ slug: p.slug, path: p.path });
      }
    }

    toEnqueueGrade.push({
      slug: p.slug,
      path: p.path,
      hasSessions: (p.claude?.sessionCount ?? 0) > 0,
    });
  }

  if (toEnqueueGit.length > 0) gitStatusCache.enqueue(toEnqueueGit);
  if (toEnqueueGrade.length > 0) efficiencyGradeCache.enqueue(toEnqueueGrade);

  // GitHub activity (Portfolio Command Deck — Phase 4): default-on. Enqueue
  // only git-tracked projects, carrying the already-scanned remote so the
  // cache skips a redundant `git remote` call; skip any project whose cache
  // entry is still fresh.
  if (getFlag(flags, "githubActivity")) {
    const toEnqueueGithub = projects
      .filter((p) => p.git)
      .map((p) => ({ slug: p.slug, path: p.path, remoteUrl: p.git?.remoteUrl }))
      .filter((it) => githubActivityCache.get(it.slug) == null);
    if (toEnqueueGithub.length > 0) githubActivityCache.enqueue(toEnqueueGithub);
  }
}
