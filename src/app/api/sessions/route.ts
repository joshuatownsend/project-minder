import { NextRequest, NextResponse } from "next/server";
import { scanAllSessions } from "@/lib/scanner/claudeConversations";
import { SessionSummary } from "@/lib/types";

let cachedSessions: SessionSummary[] | null = null;
let cachedAt = 0;
const CACHE_TTL = 2 * 60_000; // 2 minutes

export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");

  if (!cachedSessions || Date.now() - cachedAt > CACHE_TTL) {
    cachedSessions = await scanAllSessions();
    cachedAt = Date.now();
  }

  let results = cachedSessions;
  if (project) {
    results = results.filter((s) => s.projectSlug === project || s.projectName.includes(project));
  }

  return NextResponse.json(results);
}
