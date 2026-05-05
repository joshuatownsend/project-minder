import { applyPricing, getModelPricing, loadPricing } from "./costCalculator";
import {
  classifySessionsByYield,
  buildSessionIntervals,
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

  const branch = await detectMainBranch(projectPath);
  if (!branch) {
    return { kind: "unavailable", reason: "No main/master branch detected on this repo." };
  }

  await loadPricing();
  const intervals = buildSessionIntervals(turns, (t) =>
    applyPricing(getModelPricing(t.model), t)
  );

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
