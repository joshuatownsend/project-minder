import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listMemoryFiles } from "@/lib/memory";
import { canonicalMemoryKey, getMemoryUsage } from "@/lib/memory/usageTracker";
import { MEMORY_UNREAD_WINDOW_MS } from "@/lib/memory/budget";

export async function GET(request: NextRequest) {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }

  const [{ entries, indexSummaries }, usage] = await Promise.all([
    listMemoryFiles({ projects: scan.projects }),
    getMemoryUsage(scan.projects),
  ]);

  for (const e of entries) {
    const stat = usage.get(canonicalMemoryKey(e.absPath));
    if (stat) e.usage = stat;
  }

  let filtered = entries;
  if (request.nextUrl.searchParams.get("unread") === "true") {
    // "Unread in the last 30d" = either never recorded as read, or last read
    // older than the window.
    const cutoff = Date.now() - MEMORY_UNREAD_WINDOW_MS;
    filtered = entries.filter((e) => {
      if (!e.usage) return true;
      return new Date(e.usage.lastReadAt).getTime() < cutoff;
    });
  }

  return NextResponse.json({ entries: filtered, indexSummaries });
}
