import { NextRequest, NextResponse } from "next/server";
import { buildModelDelegation, type DelegationReport } from "@/lib/usage/modelDelegation";
import { isValidSessionId, parseSessionTurns } from "@/lib/usage/parser";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const globalForDelegation = globalThis as unknown as {
  __delegationCache?: Map<string, { report: DelegationReport; expiresAt: number }>;
};

function getCache() {
  if (!globalForDelegation.__delegationCache) {
    globalForDelegation.__delegationCache = new Map();
  }
  return globalForDelegation.__delegationCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const now = Date.now();
  const cache = getCache();
  const cached = cache.get(sessionId);
  if (cached && now < cached.expiresAt) {
    return NextResponse.json(cached.report);
  }

  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let filePath: string | null = null;
  let projectDirName = "";

  try {
    const dirs = await fs.readdir(projectsDir);
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        await fs.access(candidate);
        filePath = candidate;
        projectDirName = dir;
        break;
      } catch {
        // not here
      }
    }
  } catch {
    return NextResponse.json({ error: "Could not read projects directory" }, { status: 500 });
  }

  if (!filePath) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const turns = await parseSessionTurns(filePath, projectDirName, { includeSidechains: true });
  const report = buildModelDelegation(turns);

  cache.set(sessionId, { report, expiresAt: now + 60_000 });
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  return NextResponse.json(report);
}
