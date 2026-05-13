"use client";

import { useEffect, useState } from "react";
import { formatCostCompact } from "@/lib/format";
import type { SubscriptionTier, AgentBudgets } from "@/lib/types";
import { getEffectiveDailyCapUsd } from "@/lib/agentView/tierCaps";

/** Hours elapsed since local midnight, minimum 0.1 to avoid divide-by-zero. */
function hoursElapsedToday(): number {
  const now = new Date();
  return Math.max(0.1, now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600);
}

interface SpendBannerProps {
  tier: SubscriptionTier | undefined;
  budgets: AgentBudgets | undefined;
}

export function SpendBanner({ tier, budgets }: SpendBannerProps) {
  const [todayCost, setTodayCost] = useState<number | null>(null);

  const cap = getEffectiveDailyCapUsd(tier, budgets?.dailyUsd);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch("/api/usage?period=today");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setTodayCost((data as { totalCost?: number }).totalCost ?? 0);
      } catch {
        // Non-critical — banner stays hidden on fetch failure
      }
    }

    refresh();
    if (cap == null) return () => { cancelled = true; };
    const id = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cap]);

  // Don't render until we have data
  if (todayCost == null) return null;
  // No cap configured and no spend yet — nothing to show
  if (cap == null && todayCost === 0) return null;

  const ratio = cap != null && cap > 0 ? todayCost / cap : null;
  const isAmber = ratio != null && ratio >= 0.7;
  const isRed = ratio != null && ratio >= 0.9;

  const projectedDaily = todayCost > 0
    ? (todayCost / hoursElapsedToday()) * 24
    : null;

  const bg = isRed
    ? "var(--red-bg,#2d0a0a)"
    : isAmber
    ? "var(--amber-bg,#451a03)"
    : "var(--card-bg-2,#1a1a1a)";
  const fg = isRed
    ? "var(--red-text,#f87171)"
    : isAmber
    ? "var(--amber-text,#fbbf24)"
    : "var(--text-3,#888)";
  const border = isRed
    ? "var(--red-border,#7f1d1d)"
    : isAmber
    ? "var(--amber-border,#92400e)"
    : "var(--line-soft,#222)";
  const barFill = isRed
    ? "var(--red-text,#f87171)"
    : isAmber
    ? "var(--amber-text,#fbbf24)"
    : "var(--blue-text,#60a5fa)";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "6px 12px",
      marginBottom: 10,
      borderRadius: 6,
      background: bg,
      border: `1px solid ${border}`,
      fontSize: "0.7rem",
      color: fg,
    }}>
      <span style={{ fontFamily: "var(--font-mono,monospace)", flexShrink: 0 }}>
        Today: <strong>{formatCostCompact(todayCost)}</strong>
        {cap != null && (
          <> / {formatCostCompact(cap)}{ratio != null ? ` (${Math.round(ratio * 100)}%)` : ""}</>
        )}
      </span>

      {cap != null && ratio != null && (
        <div style={{
          flex: 1,
          height: 4,
          background: "var(--line-soft,#222)",
          borderRadius: 2,
          overflow: "hidden",
          minWidth: 40,
        }}>
          <div style={{
            height: "100%",
            width: `${Math.min(ratio * 100, 100)}%`,
            background: barFill,
            borderRadius: 2,
            transition: "width 0.5s ease",
          }} />
        </div>
      )}

      {projectedDaily != null && projectedDaily > 0 && (
        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono,monospace)", opacity: 0.75 }}>
          ~{formatCostCompact(projectedDaily)}/day projected
        </span>
      )}
    </div>
  );
}
