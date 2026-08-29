import { applyPricing, getModelPricing, loadPricing } from "./costCalculator";
import {
  classifySessionsByYield,
  buildSessionIntervals,
  type SessionInterval,
  type YieldResult,
} from "./yieldAnalysis";
import { detectMainBranch, readBranchCommits } from "@/lib/scanner/git";
import type { UsageTurn } from "./types";

/**
 * Shared yield computation for a single project — extracts the logic that
 * was previously inlined in the efficiency route so both the route and the
 * usage aggregator can call it without duplication.
 */
export async function computeProjectYield(
  projectPath: string,
  turns: UsageTurn[]
): Promise<YieldResult> {
  if (turns.length === 0) {
    return { kind: "unavailable", reason: "No session turns for this project." };
  }
  await loadPricing();
  return computeProjectYieldFromIntervals(
    projectPath,
    buildSessionIntervals(turns, (t) => applyPricing(getModelPricing(t.model, t.speed), t))
  );
}

/**
 * The half of the yield computation that does not need the turns (#515).
 *
 * `buildSessionIntervals` reduces a session's turns to ONE small record —
 * start, end, cost — and nothing downstream of it looks at a turn again. So a
 * caller sweeping the corpus can build intervals per session, let each
 * session's turns go, and arrive here holding kilobytes instead of the
 * project's whole transcript history.
 *
 * `computeProjectYield` is this with the reduction done for it, which is what
 * keeps the map-shaped callers (the efficiency route) working unchanged.
 *
 * Intervals must be sorted by `startMs`, as `buildSessionIntervals` returns
 * them; a caller concatenating several sessions' intervals has to re-sort.
 */
export async function computeProjectYieldFromIntervals(
  projectPath: string,
  intervals: SessionInterval[]
): Promise<YieldResult> {
  const branch = await detectMainBranch(projectPath);
  if (!branch) {
    return { kind: "unavailable", reason: "No main/master branch detected on this repo." };
  }

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
