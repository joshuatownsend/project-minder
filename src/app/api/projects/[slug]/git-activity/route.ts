import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { aggregateGitActivity, type GitActivitySummary } from "@/lib/usage/gitActivity";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";

interface GitActivityResponse {
  slug: string;
  activity: GitActivitySummary;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: GitActivityResponse;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForGitActivity = globalThis as unknown as {
  __gitActivityCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForGitActivity.__gitActivityCache) {
    globalForGitActivity.__gitActivityCache = new Map();
  }
  return globalForGitActivity.__gitActivityCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  try {
    const cache = getCache();
    const cached = cache.get(slug);
    const currentMtime = getJsonlMaxMtime();
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS && cached.jsonlMtime === currentMtime) {
      return NextResponse.json(cached.data);
    }

    let scan = getCachedScan();
    if (!scan) {
      scan = await scanAllProjects();
      setCachedScan(scan);
    }
    const project = scan.projects.find((p) => p.slug === slug);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    let activity: GitActivitySummary;

    const db = await getDb();
    if (db) {
      // DB path: single join gives commands + branch info
      type ToolRow = { arguments_json: string | null };
      type BranchRow = { git_branch: string | null; end_ts: string | null };
      const toolRows = db.prepare(
        `SELECT tu.arguments_json FROM tool_uses tu
         JOIN sessions s ON tu.session_id = s.session_id
         WHERE s.project_slug = ? AND tu.tool_name IN ('Bash', 'PowerShell')`
      ).all(slug) as ToolRow[];
      const branchRows = db.prepare(
        `SELECT DISTINCT git_branch, end_ts FROM sessions WHERE project_slug = ?`
      ).all(slug) as BranchRow[];

      const toolCommands = toolRows.map((r) => {
        try { return { command: (JSON.parse(r.arguments_json ?? "{}") as Record<string, unknown>)?.command as string ?? "" }; }
        catch { return { command: "" }; }
      });
      const sessionBranches = branchRows.map((r) => ({
        branch: r.git_branch,
        lastActivity: r.end_ts ?? "",
      }));
      activity = aggregateGitActivity(toolCommands, sessionBranches);
    } else {
      // File-parse fallback: commands only; branch list omitted (no gitBranch on UsageTurn)
      const sessionMap = await parseAllSessions();
      const projectTurns = gatherProjectTurns(sessionMap, slug, project.path);
      const toolCommands = projectTurns.flatMap((t) =>
        t.toolCalls
          .filter((tc) => tc.name === "Bash" || tc.name === "PowerShell")
          .map((tc) => ({
            command: (tc.arguments?.command as string | undefined) ??
                     (tc.arguments?.script as string | undefined) ?? "",
          }))
      );
      activity = aggregateGitActivity(toolCommands, []);
    }

    const data: GitActivityResponse = { slug, activity, generatedAt: new Date().toISOString() };
    cache.set(slug, { data, cachedAt: Date.now(), jsonlMtime: currentMtime });
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[git-activity] Error processing slug="${slug}":`, err);
    return NextResponse.json({ error: "Failed to compute git activity." }, { status: 500 });
  }
}
