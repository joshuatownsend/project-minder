"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";

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

interface Props {
  usage?: ItemUsageStats;
  /** Render the cost tile when usage carries a non-zero costUsd. Skills omit. */
  showCost?: boolean;
}

export function ItemUsageBreakdown({ usage, showCost = false }: Props) {
  const { currency, fxRate } = useCurrency();

  if (!usage || usage.invocations === 0) {
    return (
      <div
        style={{
          padding: "20px",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
          textAlign: "center",
        }}
      >
        No usage recorded yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <HeaderTiles usage={usage} showCost={showCost} currency={currency} fxRate={fxRate} />
      <ProjectBar projects={usage.projects} />
      <SessionList sessions={usage.sessions} />
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
