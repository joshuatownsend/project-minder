import { NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { listMemoryFiles } from "@/lib/memory";

export async function GET() {
  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const { entries, indexSummaries } = await listMemoryFiles({ projects: scan.projects });
  return NextResponse.json({ entries, indexSummaries });
}
