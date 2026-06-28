import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import type { MinderConfig } from "@/lib/types";

let scanInProgress: Promise<void> | null = null;

export async function GET() {
  const config = await readConfig();
  const flags = config.featureFlags;
  const cached = getCachedScan();

  if (cached) {
    // Enrich with any cached dirty status and kick off background checks
    enrichAndEnqueue(cached.projects, flags);
    return NextResponse.json(cached);
  }

  // Prevent multiple concurrent scans
  if (!scanInProgress) {
    scanInProgress = scanAllProjects()
      .then((result) => {
        setCachedScan(result);
      })
      .finally(() => {
        scanInProgress = null;
      });
  }

  await scanInProgress;

  const result = getCachedScan();
  if (result) {
    enrichAndEnqueue(result.projects, flags);
    return NextResponse.json(result);
  }

  return NextResponse.json(
    { projects: [], portConflicts: [], hiddenCount: 0, scannedAt: new Date().toISOString() }
  );
}

function enrichAndEnqueue(
  projects: {
    slug: string;
    path: string;
    git?: { isDirty: boolean; uncommittedCount: number; remoteUrl?: string };
    claude?: { sessionCount: number };
  }[],
  flags: MinderConfig["featureFlags"]
) {
  const toEnqueueGit: { slug: string; path: string }[] = [];
  const toEnqueueGrade: { slug: string; path: string; hasSessions: boolean }[] = [];

  for (const p of projects) {
    if (p.git) {
      const cached = gitStatusCache.get(p.slug);
      if (cached) {
        p.git.isDirty = cached.isDirty;
        p.git.uncommittedCount = cached.uncommittedCount;
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
