import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";

let scanInProgress: Promise<void> | null = null;

export async function GET() {
  const cached = getCachedScan();

  if (cached) {
    // Enrich with any cached dirty status and kick off background checks
    enrichAndEnqueue(cached.projects);
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
    enrichAndEnqueue(result.projects);
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
    git?: { isDirty: boolean; uncommittedCount: number };
    claude?: { sessionCount: number };
  }[]
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
}
