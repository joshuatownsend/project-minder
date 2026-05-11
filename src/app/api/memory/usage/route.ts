import { NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { getMemoryUsage } from "@/lib/memory/usageTracker";

// Debug / introspection endpoint — returns the full memory-read map keyed by
// absolute path. The dashboard joins usage onto entries via /api/memory; this
// route is the underlying telemetry source for anything that wants the raw
// map without the entry context.
export async function GET() {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const usage = await getMemoryUsage(scan.projects);
  const entries = Array.from(usage.entries())
    .map(([absPath, stat]) => ({ absPath, ...stat }))
    .sort((a, b) => b.readCount - a.readCount);
  return NextResponse.json({ entries });
}
