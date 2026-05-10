import "server-only";
import { NextResponse } from "next/server";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import {
  getCacheEfficiency,
  getEditAcceptance,
  getPressureSnapshot,
} from "@/lib/db/otelQueries";
import { getAllFindings, getLatestRun } from "@/lib/scanner/mcp-security/store";
import { computeHealthScore, type HealthInputs } from "@/lib/healthScore";

export const dynamic = "force-dynamic";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/home-health
 *
 * Aggregates the six configuration-health signals into a single weighted
 * score for the Home page gauge. All inputs are DB-backed or memory-cached
 * so this route is cheap to call on every Home mount; we don't add
 * additional caching here.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const approvals = Number(url.searchParams.get("approvals") ?? "0") || 0;

  const since = Date.now() - SEVEN_DAYS_MS;

  // efficiencyGradeCache.getAll() is synchronous (in-memory map).
  const grades = (() => {
    try {
      return efficiencyGradeCache.getAll();
    } catch {
      return {};
    }
  })();

  // Pull the async signals in parallel. If any fails individually, fall back
  // to the "no data" shape so the rest of the report still renders. We
  // resolve the latest scan run first so the findings query can be scoped
  // to that run only — `mcp_scan_findings` stores rows per run, so an
  // unscoped query accumulates fixed findings across history and the
  // health score would drift downward over time even as issues get fixed
  // (PR #103 codex P1).
  const mcpRun = await safeAwait(getLatestRun(), null);
  const [cache, mcpFindings, pressure, edit] = await Promise.all([
    safeAwait(getCacheEfficiency({ period: "7d" }), null),
    safeAwait(
      mcpRun ? getAllFindings(undefined, mcpRun.id) : Promise.resolve([]),
      [] as Awaited<ReturnType<typeof getAllFindings>>,
    ),
    safeAwait(getPressureSnapshot({ since }), null),
    safeAwait(getEditAcceptance({ since }), null),
  ]);

  const findingsBucket = bucketBySeverity(mcpFindings);

  const inputs: HealthInputs = {
    grades,
    cacheHitRate: cache?.hasData ? cache.hitRate : null,
    mcpFindings: findingsBucket,
    mcpScanned: mcpRun !== null,
    approvals,
    pressure: pressure
      ? {
          retryExhaustion: pressure.retryExhaustionCount,
          compactions: pressure.compactionCount,
          hasData: pressure.hasData,
        }
      : { retryExhaustion: 0, compactions: 0, hasData: false },
    editAcceptance: edit
      ? { rate: deriveAcceptRate(edit.tools), n: edit.totalN, hasData: edit.hasData }
      : { rate: 0, n: 0, hasData: false },
  };

  const report = computeHealthScore(inputs);

  return NextResponse.json(report);
}

async function safeAwait<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

function bucketBySeverity(
  findings: Awaited<ReturnType<typeof getAllFindings>>,
): { crit: number; high: number; med: number; low: number; info: number } {
  const out = { crit: 0, high: 0, med: 0, low: 0, info: 0 };
  for (const f of findings) {
    const sev = f.severity as keyof typeof out;
    if (sev in out) out[sev]++;
  }
  return out;
}

// Aggregate accept-rate across all tools weighted by sample count. Mirrors
// what EditAcceptanceCard's headline shows but at a portfolio level.
function deriveAcceptRate(
  tools: Array<{ accepted: number; rejected: number }>,
): number {
  let accepted = 0, total = 0;
  for (const t of tools) {
    accepted += t.accepted;
    total += t.accepted + t.rejected;
  }
  return total > 0 ? accepted / total : 0;
}
