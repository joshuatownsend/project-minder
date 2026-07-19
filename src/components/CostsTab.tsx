"use client";

import { useState } from "react";
import Link from "next/link";
import { useUsage } from "@/hooks/useUsage";
import { useCurrency } from "@/hooks/useCurrency";
import { COST_PERIODS } from "@/lib/usage/constants";
import { formatCost, formatTokens } from "@/lib/format";
import { StatCell } from "@/components/ui/StatCell";
import { Skeleton } from "@/components/ui/skeleton";

const DEFAULT_PERIOD = "30d";

/**
 * Per-project cost breakdown for the project detail page. Keyed on the project's
 * `usageSlug` (the encoded-conversation-dir slug the usage module aggregates on),
 * NOT the route slug — the two differ (see ProjectData.usageSlug). Reuses the
 * existing `/api/usage?period=&project=` endpoint via `useUsage`. For mapped
 * (e.g. WSL) projects, `usageHomeKey` rides along as `&home=` so two distros
 * with identical path layouts don't mix spend (#311).
 */
export function CostsTab({ usageSlug, usageHomeKey }: { usageSlug: string; usageHomeKey?: string }) {
  const [period, setPeriod] = useState<string>(DEFAULT_PERIOD);
  const { data, loading } = useUsage(period, usageSlug, usageHomeKey);
  const { currency, fxRate } = useCurrency();

  const byModel = [...(data?.byModel ?? [])].sort((a, b) => b.cost - a.cost);
  const byCategory = (data?.byCategory ?? [])
    .filter((c) => c.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Period switcher + link to the cross-project report */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <div style={{
          display: "flex",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}>
          {COST_PERIODS.map((p, i) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color: period === p.value ? "var(--text-primary)" : "var(--text-secondary)",
                background: period === p.value ? "var(--bg-elevated)" : "transparent",
                border: "none",
                borderRight: i < COST_PERIODS.length - 1 ? "1px solid var(--border-subtle)" : "none",
                cursor: "pointer", lineHeight: 1,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <Link
          href="/costs"
          style={{
            fontSize: "0.7rem", fontFamily: "var(--font-body)",
            color: "var(--text-secondary)", textDecoration: "none",
          }}
        >
          All projects →
        </Link>
      </div>

      {loading && !data ? (
        <Skeleton className="h-40" />
      ) : !data || data.totalCost === 0 ? (
        <div style={{
          padding: "32px", textAlign: "center",
          color: "var(--text-muted)", fontSize: "0.8rem", fontFamily: "var(--font-body)",
        }}>
          No cost recorded for this project in the selected period.
        </div>
      ) : (
        <>
          {/* Headline stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px" }}>
            <StatCell label="Total cost" value={formatCost(data.totalCost, currency, fxRate)} />
            <StatCell label="Tokens" value={formatTokens(data.totalTokens)} />
            <StatCell label="Turns" value={data.totalTurns.toLocaleString()} />
            <StatCell label="Sessions" value={data.totalSessions.toLocaleString()} />
          </div>

          {/* By model */}
          {byModel.length > 0 && (
            <section>
              <SectionHeader label="By model" />
              <CostList
                rows={byModel.map((m) => ({ key: m.model, label: m.model, cost: m.cost, sub: `${formatTokens(m.inputTokens + m.outputTokens)} tok` }))}
                total={data.totalCost}
                currency={currency}
                fxRate={fxRate}
              />
            </section>
          )}

          {/* By category */}
          {byCategory.length > 0 && (
            <section>
              <SectionHeader label="By category" />
              <CostList
                rows={byCategory.map((c) => ({ key: c.category, label: c.category, cost: c.cost, sub: `${c.turns} turns` }))}
                total={data.totalCost}
                currency={currency}
                fxRate={fxRate}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
      <span style={{
        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function CostList({ rows, total, currency, fxRate }: {
  rows: { key: string; label: string; cost: number; sub?: string }[];
  total: number; currency: string; fxRate: number;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.cost), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.72rem",
            color: "var(--text-secondary)", width: "160px",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
          }}>
            {r.label}
          </span>
          <div style={{ flex: 1, background: "var(--bg-elevated)", borderRadius: "2px", height: "10px", overflow: "hidden" }}>
            <div style={{
              width: "100%",
              transform: `scaleX(${max > 0 ? r.cost / max : 0})`,
              transformOrigin: "left",
              height: "100%", background: "var(--accent)", borderRadius: "2px",
              transition: "transform 0.3s ease",
            }} />
          </div>
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.7rem",
            color: "var(--text-primary)", width: "64px", textAlign: "right", flexShrink: 0,
          }}>
            {formatCost(r.cost, currency, fxRate)}
          </span>
          {r.sub && (
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: "0.62rem",
              color: "var(--text-muted)", width: "72px", textAlign: "right", flexShrink: 0,
            }}>
              {r.sub}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
