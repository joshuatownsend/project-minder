import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { runWasteOptimizer, type WasteOptimizerInfo } from "@/lib/scanner/wasteOptimizer";
import {
  classifySessionsByYield,
  buildSessionIntervals,
  type YieldResult,
} from "@/lib/usage/yieldAnalysis";
import { detectMainBranch, readBranchCommits } from "@/lib/scanner/git";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { applyPricing, getModelPricing, loadPricing } from "@/lib/usage/costCalculator";
import type { UsageTurn } from "@/lib/usage/types";

// On-demand per-project efficiency report. Cached on globalThis with a
// 5-min TTL keyed by slug; cache also bypassed when the JSONL maxMtime
// advances so newly-ingested sessions surface promptly.

/**
 * Convert a Windows or POSIX project path to the canonical dirname
 * Claude Code uses under `~/.claude/projects/`. The encoding rule:
 * `:`, `\`, and `.` all become `-`. Used to match parser-produced
 * `projectDirName` exactly to a scanned project.
 */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\.]/g, "-");
}

interface EfficiencyResponse {
  slug: string;
  waste: WasteOptimizerInfo;
  yieldReport: YieldResult;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: EfficiencyResponse;
  cachedAt: number;
  jsonlMtime: number;
}

const globalForEfficiency = globalThis as unknown as {
  __efficiencyCache?: Map<string, CacheSlot>;
};

function getCache(): Map<string, CacheSlot> {
  if (!globalForEfficiency.__efficiencyCache) {
    globalForEfficiency.__efficiencyCache = new Map();
  }
  return globalForEfficiency.__efficiencyCache;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const cache = getCache();
  const cached = cache.get(slug);
  const currentMtime = getJsonlMaxMtime();
  if (
    cached &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS &&
    cached.jsonlMtime === currentMtime
  ) {
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

  // parseAllSessions + loadCatalog are independent I/O. Run concurrently.
  const [sessionMap, catalog] = await Promise.all([
    parseAllSessions(),
    loadCatalog({ includeProjects: true }),
  ]);

  // Match turns to this project exactly. Two paths produce different
  // identifiers for the same directory: scanner uses `toSlug("project-
  // minder") = "project-minder"`; parser uses `toSlug("C--dev-project-
  // minder") = "dev-project-minder"` from the encoded dirname. To match
  // safely without substring false-positives (e.g. slug "api" matching
  // "my-api-server"), we match on (a) exact slug equality, OR (b) exact
  // canonical-dirname equality derived from the project's filesystem
  // path. Reviewer-flagged (Codex P1).
  //
  // Per-session early-out: every turn in a session shares the same
  // projectSlug + projectDirName, so checking the first turn before
  // walking the rest saves ~99% of the corpus on large installs.
  const expectedDirName = encodeProjectPath(project.path);
  const projectTurns: UsageTurn[] = [];
  for (const turns of sessionMap.values()) {
    if (turns.length === 0) continue;
    const head = turns[0];
    const matches =
      head.projectSlug === slug ||
      head.projectDirName === expectedDirName;
    if (!matches) continue;
    for (const t of turns) projectTurns.push(t);
  }

  const waste = runWasteOptimizer({
    turns: projectTurns,
    configuredMcpServers: project.mcpServers?.servers ?? [],
    agents: catalog.agents.filter((a) => !a.projectSlug || a.projectSlug === slug),
    skills: catalog.skills.filter((s) => !s.projectSlug || s.projectSlug === slug),
  });

  let yieldReport: YieldResult;
  try {
    yieldReport = await computeYield(project.path, projectTurns);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[/api/projects/${slug}/efficiency] yield computation failed`, err);
    yieldReport = {
      kind: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const data: EfficiencyResponse = {
    slug,
    waste,
    yieldReport,
    generatedAt: new Date().toISOString(),
  };
  cache.set(slug, { data, cachedAt: Date.now(), jsonlMtime: currentMtime });
  return NextResponse.json(data);
}

async function computeYield(
  projectPath: string,
  turns: UsageTurn[]
): Promise<YieldResult> {
  if (turns.length === 0) {
    return { kind: "unavailable", reason: "No session turns for this project." };
  }

  const branch = await detectMainBranch(projectPath);
  if (!branch) {
    return { kind: "unavailable", reason: "No main/master branch detected on this repo." };
  }

  await loadPricing();
  const intervals = buildSessionIntervals(turns, (t) =>
    applyPricing(getModelPricing(t.model), t)
  );

  // `buildSessionIntervals` only emits intervals for sessions with at
  // least one assistant turn. If every turn in `turns` was a user turn
  // (rare but possible), `intervals` is empty — without this guard we'd
  // fall through with `sinceIso = undefined` and `git log` would scan
  // unbounded history. Reviewer-flagged (Copilot).
  if (intervals.length === 0) {
    return { kind: "unavailable", reason: "No assistant turns to align with commits." };
  }

  let earliest = Infinity;
  for (const iv of intervals) {
    if (iv.startMs < earliest) earliest = iv.startMs;
  }
  const sinceIso = new Date(earliest - 24 * 60 * 60 * 1000).toISOString();

  const commits = await readBranchCommits(projectPath, branch, sinceIso);
  return { kind: "ok", report: classifySessionsByYield({ intervals, commits }) };
}
