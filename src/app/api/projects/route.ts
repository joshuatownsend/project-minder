import { NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";

let scanInProgress: Promise<void> | null = null;

export async function GET() {
  const cached = getCachedScan();

  if (cached) {
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
    return NextResponse.json(result);
  }

  return NextResponse.json(
    { projects: [], portConflicts: [], hiddenCount: 0, scannedAt: new Date().toISOString() }
  );
}
