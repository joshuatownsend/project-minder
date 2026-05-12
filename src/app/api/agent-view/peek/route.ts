import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { getHookBuffer } from "@/lib/hooks/buffer";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import { parseInsightsFromJsonl } from "@/lib/scanner/insightsMd";
import type { InsightEntry } from "@/lib/types";

// Returns hook events + JSONL-sourced insights for a session.
// Used by AgentPeekPanel — best-effort; errors return empty arrays.

// Mtime-keyed per-session cache to avoid re-parsing JSONL on every peek open.
const g = globalThis as unknown as {
  __peekInsightsCache?: Map<string, { mtime: number; insights: InsightEntry[] }>;
};
function getInsightsCache() {
  if (!g.__peekInsightsCache) g.__peekInsightsCache = new Map();
  return g.__peekInsightsCache;
}

async function loadInsightsForSession(
  sessionId: string,
  slug: string,
): Promise<InsightEntry[]> {
  const resolved = await resolveSessionJsonl(sessionId);
  if (!resolved) return [];
  const { filePath } = resolved;

  let mtime: number;
  let jsonlContent: string;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
    jsonlContent = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const cache = getInsightsCache();
  const cached = cache.get(sessionId);
  if (cached && cached.mtime === mtime) return cached.insights;

  const insights = parseInsightsFromJsonl(jsonlContent, sessionId, slug, "");
  cache.set(sessionId, { mtime, insights });
  return insights;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = request.nextUrl.searchParams.get("slug") ?? "";
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";

  const hookEvents = [...getHookBuffer(slug)].filter(
    (e) => !sessionId || e.sessionId === sessionId,
  );

  const insightsThisSession = sessionId
    ? await loadInsightsForSession(sessionId, slug).catch(() => [] as InsightEntry[])
    : [];

  return NextResponse.json({ hookEvents, insightsThisSession });
}
