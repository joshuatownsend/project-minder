"use client";

import { useEffect, useRef } from "react";
import type { LiveAgentSession } from "@/lib/agentView/types";
import { computeAlerts } from "@/lib/agentView/budgetAlerts";

/**
 * Fires an OS notification when a session's cost crosses 80% or 100% of the
 * configured per-session budget. Each threshold fires at most once per session
 * per page load (tracked in a stable ref).
 */
export function useBudgetAlerts(
  sessions: LiveAgentSession[],
  sessionBudgetUsd: number | undefined,
): void {
  const firedRef = useRef<Map<string, Set<number>>>(new Map());

  useEffect(() => {
    if (!sessionBudgetUsd || sessionBudgetUsd <= 0) return;
    if (typeof Notification === "undefined") return;

    const alerts = computeAlerts(sessions, sessionBudgetUsd, firedRef.current);
    if (alerts.length === 0) return;

    async function fire() {
      let perm = Notification.permission;
      if (perm === "default") {
        perm = await Notification.requestPermission();
      }
      if (perm !== "granted") return;

      for (const alert of alerts) {
        const pct = Math.round(alert.threshold * 100);
        new Notification(`Budget alert — ${alert.projectName}`, {
          body: `Session cost reached ${pct}% of your $${sessionBudgetUsd!.toFixed(2)} budget ($${alert.cost.toFixed(4)})`,
          tag: `budget-${alert.sessionId}-${alert.threshold}`,
        });
      }
    }

    fire();
  }, [sessions, sessionBudgetUsd]);
}
