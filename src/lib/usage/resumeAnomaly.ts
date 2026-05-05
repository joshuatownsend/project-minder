import type { UsageTurn } from "@/lib/usage/types";
import { isBuggyVersion } from "@/lib/usage/versionDetector";

export const RESUME_OUTPUT_SPIKE_RATIO = 10;
const WINDOW_SIZE = 20;

export interface AnomalyReason {
  kind: "output-spike" | "cache-spike" | "buggy-version";
  message: string;
}

export interface ResumeAnomalyResult {
  hasAnomaly: boolean;
  reasons: AnomalyReason[];
}

/**
 * Detect resume anomalies around compact_boundary events. For each
 * boundary timestamp, computes a pre-boundary median of `outputTokens`
 * and flags if any post-boundary assistant turn exceeds
 * RESUME_OUTPUT_SPIKE_RATIO × that median.
 *
 * Additionally flags buggy CLI version (2.1.69–2.1.89 prompt cache bug)
 * as a separate reason.
 */
export function detectResumeAnomaly(
  turns: UsageTurn[],
  extras: { compactBoundaries: string[]; cliVersion?: string | null }
): ResumeAnomalyResult {
  const reasons: AnomalyReason[] = [];

  if (isBuggyVersion(extras.cliVersion ?? undefined)) {
    reasons.push({
      kind: "buggy-version",
      message: `buggy CLI version (${extras.cliVersion} — 2.1.69–2.1.89 prompt cache bug)`,
    });
  }

  const assistantTurns = turns.filter((t) => t.role === "assistant");
  const assistantWithMs = assistantTurns.map((t) => ({
    ...t,
    tsMs: new Date(t.timestamp).getTime(),
  }));

  for (const boundary of extras.compactBoundaries) {
    const boundaryTs = new Date(boundary).getTime();

    const pre = assistantWithMs
      .filter((t) => t.tsMs < boundaryTs)
      .slice(-WINDOW_SIZE);
    const post = assistantWithMs
      .filter((t) => t.tsMs >= boundaryTs)
      .slice(0, WINDOW_SIZE);

    if (pre.length === 0 || post.length === 0) continue;

    const sorted = [...pre].sort((a, b) => a.outputTokens - b.outputTokens);
    const mid = Math.floor(sorted.length / 2);
    const preMedian =
      sorted.length % 2 === 0
        ? (sorted[mid - 1].outputTokens + sorted[mid].outputTokens) / 2
        : sorted[mid].outputTokens;

    if (preMedian <= 0) continue;

    const spike = post.find(
      (t) => t.outputTokens > RESUME_OUTPUT_SPIKE_RATIO * preMedian
    );
    if (spike) {
      reasons.push({
        kind: "output-spike",
        message:
          `output token spike after compact boundary at ${boundary}: ` +
          `${spike.outputTokens} tokens (${Math.round(spike.outputTokens / preMedian)}× pre-boundary median)`,
      });
    }

    const cacheSpike = post.find(
      (t) => t.cacheCreateTokens > 5000 && t.cacheReadTokens < 100
    );
    if (cacheSpike) {
      reasons.push({
        kind: "cache-spike",
        message:
          `cache rebuild spike after compact boundary at ${boundary}: ` +
          `${cacheSpike.cacheCreateTokens} cache_create tokens with near-zero cache reads`,
      });
    }
  }

  return {
    hasAnomaly: reasons.some((r) => r.kind !== "buggy-version"),
    reasons,
  };
}
