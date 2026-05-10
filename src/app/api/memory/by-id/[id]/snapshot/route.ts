import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { list as listHistory } from "@/lib/configHistory";
import { classifyMemoryPath, decodeMemoryId } from "@/lib/memory/safety";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const absPath = decodeMemoryId(id);
  if (!absPath) {
    return NextResponse.json({ error: { code: "INVALID_ID" } }, { status: 400 });
  }

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const allowed = await classifyMemoryPath(absPath, scan.projects);
  if (!allowed) {
    return NextResponse.json(
      { error: { code: "PATH_NOT_ALLOWED" } },
      { status: 400 },
    );
  }

  const entries = await listHistory();
  const resolved = path.resolve(absPath);
  // listHistory() returns newest-first, so the first match is the latest.
  const latest = entries.find(
    (e) => path.resolve(e.targetPath) === resolved && !e.wasMissing && e.snapshotPath,
  );
  if (!latest || !latest.snapshotPath) {
    return NextResponse.json({ snapshot: null });
  }

  try {
    const encoded = await fs.readFile(latest.snapshotPath, "utf-8");
    const content = Buffer.from(encoded, "base64").toString("utf-8");
    return NextResponse.json({
      snapshot: { content, timestamp: latest.timestamp },
    });
  } catch {
    return NextResponse.json({ snapshot: null });
  }
}
