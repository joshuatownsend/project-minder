import { NextRequest, NextResponse } from "next/server";
import { parseAllSessions, getJsonlMaxMtime } from "@/lib/usage/parser";
import { runWasteOptimizer, type WasteOptimizerInfo } from "@/lib/scanner/wasteOptimizer";
import type { YieldResult } from "@/lib/usage/yieldAnalysis";
import { computeProjectYield } from "@/lib/usage/computeProjectYield";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { gatherProjectTurns } from "@/lib/usage/projectMatch";
import { classifyTurn } from "@/lib/usage/classifier";
import { aggregateWorkMode } from "@/lib/usage/workMode";
import { recordGradeSnapshot, loadGradeTrend, type GradeTrend } from "@/lib/data/gradeSnapshots";
import { getOrCreateRouteCache } from "@/lib/routeCache";

// On-demand per-project efficiency report. Cached on globalThis with a
// 5-min TTL keyed by slug; cache also bypassed when the JSONL maxMtime
// advances so newly-ingested sessions surface promptly.

interface WorkModeDistribution {
  exploration: number;
  building: number;
  testing: number;
  other: number;
}

interface EfficiencyResponse {
  slug: string;
  waste: WasteOptimizerInfo;
  yieldReport: YieldResult;
  workMode: WorkModeDistribution;
  /** Grade movement vs the most-recent prior-day snapshot (item 4b). null
   *  when the DB is unavailable (render no trend indicator). */
  trend: GradeTrend | null;
  generatedAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheSlot {
  data: EfficiencyResponse;
  jsonlMtime: number;
}

const cache = getOrCreateRouteCache<CacheSlot>("efficiency", { ttlMs: CACHE_TTL_MS });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const cached = cache.get(slug);
  const currentMtime = getJsonlMaxMtime();
  if (cached && cached.jsonlMtime === currentMtime) {
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

  const projectTurns = gatherProjectTurns(sessionMap, slug, project.path);

  const waste = runWasteOptimizer({
    turns: projectTurns,
    configuredMcpServers: project.mcpServers?.servers ?? [],
    agents: catalog.agents.filter((a) => !a.projectSlug || a.projectSlug === slug),
    skills: catalog.skills.filter((s) => !s.projectSlug || s.projectSlug === slug),
  });

  let yieldReport: YieldResult;
  try {
    yieldReport = await computeProjectYield(project.path, projectTurns);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[/api/projects/${slug}/efficiency] yield computation failed`, err);
    yieldReport = {
      kind: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const workMode = aggregateWorkMode(
    projectTurns
      .filter((t) => t.role === "assistant")
      .map((t) => ({ category: classifyTurn(t) }))
  );

  // Record today's snapshot for this project, then classify the trend against
  // the most-recent prior-day snapshot. Both are best-effort (no-op / null
  // when the DB is unavailable) and never block the report. The write happens
  // BEFORE the trend read, which queries snapshot_date < today — so today's
  // just-written row can't pollute its own trend.
  //
  // One `now` for BOTH calls: if the request crossed local midnight between
  // them, separate `new Date()`s could write under yesterday's date while the
  // read used today's — making the just-written row its own "prior" (a false
  // self-comparison) and skipping the new day's snapshot. A single instant
  // keeps the same-day exclusion invariant intact.
  const now = new Date();
  await recordGradeSnapshot({ slug, grade: waste.grade, counts: waste.counts }, now);
  const trend = await loadGradeTrend(slug, waste.grade, now);

  const data: EfficiencyResponse = {
    slug,
    waste,
    yieldReport,
    workMode,
    trend,
    generatedAt: new Date().toISOString(),
  };
  cache.set(slug, { data, jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
