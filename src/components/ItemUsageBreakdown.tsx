"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";
import { DETAIL_PERIODS, type UsagePeriod } from "@/lib/usage/period";

export interface ItemUsageStats {
  name: string;
  invocations: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Record<string, number>;
  sessions: string[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// Detail-page-only — the canonical 5-option set lives in
// VALID_PERIODS (constants.ts); the agent/skill detail page renders
// the 4-option subset (DETAIL_PERIODS in period.ts) and uses these
// shorthand labels in the toggle. Empty-state copy is rolling-window
// phrased because the toggle excludes calendar-today.
const PERIOD_TOGGLE_LABEL: Partial<Record<UsagePeriod, string>> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "All",
};

const PERIOD_EMPTY_MESSAGE: Partial<Record<UsagePeriod, string>> = {
  "24h": "No invocations in the last 24 hours.",
  "7d": "No invocations in the last 7 days.",
  "30d": "No invocations in the last 30 days.",
  all: "No usage recorded yet.",
};

interface Props {
  usage?: ItemUsageStats;
  /** Render the cost tile when usage carries a non-zero costUsd. Skills omit. */
  showCost?: boolean;
  /** Currently-selected window. Controls the toggle highlight + empty-state copy. */
  period?: UsagePeriod;
  /** Called when the user picks a different window. Omit to hide the toggle. */
  onPeriodChange?: (period: UsagePeriod) => void;
  /** When true, the parent is refetching for a new period — dims the body
   *  so the user sees the change registered without an empty flash. */
  loading?: boolean;
}

export function ItemUsageBreakdown({
  usage,
  showCost = false,
  period = "all",
  onPeriodChange,
  loading = false,
}: Props) {
  const { currency, fxRate } = useCurrency();

  const toggle = onPeriodChange ? (
    <PeriodToggle value={period} onChange={onPeriodChange} />
  ) : null;

  if (!usage || usage.invocations === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {toggle}
        <div
          style={{
            padding: "20px",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            textAlign: "center",
            opacity: loading ? 0.5 : 1,
          }}
        >
          {PERIOD_EMPTY_MESSAGE[period] ?? "No usage recorded in this window."}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", opacity: loading ? 0.6 : 1 }}>
      {toggle}
      <HeaderTiles usage={usage} showCost={showCost} currency={currency} fxRate={fxRate} />
      <ProjectBar projects={usage.projects} />
      <SessionList sessions={usage.sessions} />
    </div>
  );
}

function PeriodToggle({
  value,
  onChange,
}: {
  value: UsagePeriod;
  onChange: (period: UsagePeriod) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Time window"
      style={{
        display: "inline-flex",
        gap: "4px",
        padding: "3px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        alignSelf: "flex-start",
      }}
    >
      {DETAIL_PERIODS.map((p) => {
        const active = p.value === value;
        return (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(p.value)}
            style={{
              padding: "4px 10px",
              fontSize: "0.7rem",
              fontFamily: "var(--font-mono)",
              fontWeight: active ? 600 : 400,
              color: active ? "var(--text-primary)" : "var(--text-muted)",
              background: active ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderRadius: "calc(var(--radius) - 2px)",
              cursor: "pointer",
              letterSpacing: "0.02em",
            }}
          >
            {PERIOD_TOGGLE_LABEL[p.value] ?? p.label}
          </button>
        );
      })}
    </div>
  );
}

function HeaderTiles({
  usage,
  showCost,
  currency,
  fxRate,
}: {
  usage: ItemUsageStats;
  showCost: boolean;
  currency: string;
  fxRate: number;
}) {
  const tiles: Array<{ label: string; value: string; detail?: string }> = [
    { label: "Invocations", value: String(usage.invocations) },
  ];
  if (showCost && typeof usage.costUsd === "number" && usage.costUsd > 0) {
    tiles.push({
      label: "Total cost",
      value: formatCost(usage.costUsd, currency, fxRate),
      detail:
        usage.inputTokens !== undefined && usage.outputTokens !== undefined
          ? `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`
          : undefined,
    });
  }
  if (usage.lastUsed) {
    tiles.push({ label: "Last used", value: formatRelativeTime(usage.lastUsed) });
  }
  if (usage.firstUsed) {
    tiles.push({ label: "First used", value: formatRelativeTime(usage.firstUsed) });
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${tiles.length}, 1fr)`,
        gap: "10px",
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.label}
          style={{
            padding: "10px 14px",
            borderRadius: "var(--radius)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {t.label}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1.2rem",
              fontWeight: 700,
              color: "var(--text-primary)",
              lineHeight: 1,
            }}
          >
            {t.value}
          </span>
          {t.detail && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                color: "var(--text-muted)",
              }}
            >
              {t.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ProjectBar({ projects }: { projects: Record<string, number> }) {
  const entries = Object.entries(projects)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  const max = entries[0][1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Invocations by project
      </span>
      {entries.map(([project, count]) => (
        <div
          key={project}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "4px 0",
          }}
        >
          <span
            style={{
              flex: "0 0 160px",
              fontSize: "0.75rem",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={project}
          >
            {project}
          </span>
          <div
            style={{
              flex: 1,
              height: "8px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(count / max) * 100}%`,
                height: "100%",
                background: "var(--info)",
              }}
            />
          </div>
          <span
            style={{
              flex: "0 0 36px",
              textAlign: "right",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-primary)",
              fontWeight: 600,
            }}
          >
            {count}×
          </span>
        </div>
      ))}
    </div>
  );
}

function SessionList({ sessions }: { sessions: string[] }) {
  if (sessions.length === 0) return null;

  const visible = sessions.slice(0, 12);
  const remaining = sessions.length - visible.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Recent sessions
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {visible.map((sid) => (
          <Link
            key={sid}
            href={`/sessions/${sid}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "0.65rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              textDecoration: "none",
              padding: "3px 8px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <ExternalLink style={{ width: "10px", height: "10px" }} />
            {sid.slice(0, 8)}
          </Link>
        ))}
        {remaining > 0 && (
          <span
            style={{
              fontSize: "0.65rem",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              alignSelf: "center",
            }}
          >
            +{remaining} more
          </span>
        )}
      </div>
    </div>
  );
}
