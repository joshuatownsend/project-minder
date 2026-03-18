import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { gitStatusCache } from "@/lib/gitStatusCache";

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
  projects: { slug: string; path: string; git?: { isDirty: boolean; uncommittedCount: number } }[]
) {
  const toEnqueue: { slug: string; path: string }[] = [];

  for (const p of projects) {
    if (!p.git) continue;
    const cached = gitStatusCache.get(p.slug);
    if (cached) {
      p.git.isDirty = cached.isDirty;
      p.git.uncommittedCount = cached.uncommittedCount;
    } else {
      toEnqueue.push({ slug: p.slug, path: p.path });
    }
  }

  if (toEnqueue.length > 0) {
    gitStatusCache.enqueue(toEnqueue);
  }
}
