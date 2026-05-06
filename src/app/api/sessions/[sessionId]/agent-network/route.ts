import { NextRequest, NextResponse } from "next/server";
import { buildAgentNetwork, type NetworkReport } from "@/lib/usage/agentNetwork";
import { isValidSessionId, parseSessionTurns } from "@/lib/usage/parser";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const globalForNetwork = globalThis as unknown as {
  __agentNetworkCache?: Map<string, { report: NetworkReport; expiresAt: number }>;
};

function getCache() {
  if (!globalForNetwork.__agentNetworkCache) {
    globalForNetwork.__agentNetworkCache = new Map();
  }
  return globalForNetwork.__agentNetworkCache;
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
  const report = buildAgentNetwork(turns);

  cache.set(sessionId, { report, expiresAt: now + 60_000 });
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }

  return NextResponse.json(report);
}
