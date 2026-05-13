import type { LiveAgentSession } from "./types";

export interface BudgetAlert {
  sessionId: string;
  projectName: string;
  /** 0.8 or 1.0 — the threshold that was just crossed. */
  threshold: number;
  cost: number;
}

const THRESHOLDS = [0.8, 1.0] as const;

/**
 * Pure function — determines which budget alerts should fire given the current
 * session list and the caller-managed fired-set map.
 *
 * Mutates `firedMap` to mark thresholds as fired. Returns only alerts that
 * are newly crossing a threshold for the first time in this map's lifetime,
 * so callers can call this on every SSE delta without re-firing.
 */
export function computeAlerts(
  sessions: LiveAgentSession[],
  sessionBudgetUsd: number,
  firedMap: Map<string, Set<number>>,
): BudgetAlert[] {
  const toFire: BudgetAlert[] = [];

  for (const s of sessions) {
    if (s.costEstimate == null || s.costEstimate <= 0) continue;
    const ratio = s.costEstimate / sessionBudgetUsd;

    let fired = firedMap.get(s.sessionId);
    if (!fired) {
      fired = new Set();
      firedMap.set(s.sessionId, fired);
    }

    for (const threshold of THRESHOLDS) {
      if (ratio >= threshold && !fired.has(threshold)) {
        fired.add(threshold);
        toFire.push({ sessionId: s.sessionId, projectName: s.projectName, threshold, cost: s.costEstimate });
      }
    }
  }

  return toFire;
}
