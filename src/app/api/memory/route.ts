import { NextResponse, type NextRequest } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listMemoryFiles } from "@/lib/memory";
import { getMemoryUsage } from "@/lib/memory/usageTracker";

const UNREAD_WINDOW_MS = 30 * 24 * 60 * 60_000;

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

  // Stamp usage onto each entry by absPath. Files with no recorded reads
  // leave `usage` undefined — the chip renders only when telemetry exists.
  for (const e of entries) {
    const stat = usage.get(e.absPath);
    if (stat) e.usage = stat;
  }

  const url = new URL(request.url);
  let filtered = entries;
  if (url.searchParams.get("unread") === "true") {
    // "Unread in the last 30d" = either never recorded as read, or last read
    // older than the window. The 30d threshold mirrors the existing age-based
    // staleness signal so both filters tell a consistent story.
    const cutoff = Date.now() - UNREAD_WINDOW_MS;
    filtered = entries.filter((e) => {
      if (!e.usage) return true;
      return new Date(e.usage.lastReadAt).getTime() < cutoff;
    });
  }

  return NextResponse.json({ entries: filtered, indexSummaries });
}
