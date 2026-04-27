"use client";

import { useState } from "react";
import { useUsage } from "@/hooks/useUsage";
import { VALID_PERIODS } from "@/lib/usage/constants";
import type { CategoryType, ProjectDetail } from "@/lib/usage/types";
import { Download, Layers, AlignJustify } from "lucide-react";

// ── Formatters ─────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}

function formatCostCompact(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

// ── Project name decode ────────────────────────────────────────────────────
// Claude encodes paths as: C:\dev\project-minder → C--dev-project-minder
// (colons and backslashes all become hyphens; project-internal hyphens stay).
// To get the display name, strip the drive letter prefix (X--) and the
// first path segment (the devRoot dir, typically "dev") and join the rest.

function decodeProjectName(encoded: string): string {
  const withoutDrive = encoded.replace(/^[A-Z]--/, "");        // "dev-project-minder"
  const firstDash = withoutDrive.indexOf("-");
  if (firstDash === -1) return withoutDrive;
  return withoutDrive.slice(firstDash + 1);                    // "project-minder"
}

// ── Category color mapping ─────────────────────────────────────────────────

function categoryColor(cat: CategoryType): string {
  switch (cat) {
    case "Coding":
    case "Feature Dev":
    case "Refactoring":
      return "var(--accent)";                   // amber
    case "Testing":
    case "Debugging":
    case "Build/Deploy":
    case "Git Ops":
      return "var(--status-error-text)";        // red-ish
    case "Planning":
    case "Brainstorming":
    case "Exploration":
    case "Delegation":
      return "var(--status-active-text)";       // green
    default:                                    // Conversation, General
      return "var(--text-secondary)";
  }
}

// ── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
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

// ── Stat Cell ──────────────────────────────────────────────────────────────

function StatCell({ label, value, detail, accent, last }: {
  label: string; value: string | number; detail?: string;
  accent?: "error" | "warn" | "good"; last?: boolean;
}) {
  const valueColor =
    accent === "error" ? "var(--status-error-text)" :
    accent === "warn"  ? "var(--accent)" :
    accent === "good"  ? "var(--status-active-text)" :
    "var(--text-primary)";

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: "3px",
      padding: "14px 20px",
      borderRight: last ? "none" : "1px solid var(--border-subtle)",
      minWidth: "90px", flex: "1 1 90px",
    }}>
      <span style={{
        fontSize: "0.6rem", fontWeight: 600, letterSpacing: "0.08em",
        textTransform: "uppercase", color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "1.25rem", fontWeight: 600,
        color: valueColor, lineHeight: 1.1,
      }}>
        {value}
      </span>
      {detail && (
        <span style={{
          fontSize: "0.62rem", color: "var(--text-muted)",
          fontFamily: "var(--font-mono)", lineHeight: 1.4,
        }}>
          {detail}
        </span>
      )}
    </div>
  );
}

// ── Cost Bar Row ───────────────────────────────────────────────────────────

function CostRow({ label, cost, maxCost, color, detail }: {
  label: string; cost: number; maxCost: number; color: string; detail?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.71rem",
        color: "var(--text-secondary)", width: "130px", textAlign: "right",
        flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{
        flex: 1, background: "var(--bg-elevated)",
        borderRadius: "2px", height: "12px", overflow: "hidden",
      }}>
        <div style={{
          width: "100%",
          transform: `scaleX(${maxCost > 0 ? cost / maxCost : 0})`,
          transformOrigin: "left",
          height: "100%", background: color, borderRadius: "2px",
          transition: "transform 0.3s ease",
        }} />
      </div>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.68rem",
        color: "var(--text-secondary)", width: "54px", textAlign: "right", flexShrink: 0,
      }}>
        {formatCostCompact(cost)}
      </span>
      {detail && (
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: "0.62rem",
          color: "var(--text-muted)", width: "36px", textAlign: "right", flexShrink: 0,
        }}>
          {detail}
        </span>
      )}
    </div>
  );
}

// ── Count Bar Row ──────────────────────────────────────────────────────────

function CountRow({ label, count, maxCount, color }: {
  label: string; count: number; maxCount: number; color: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.71rem",
        color: "var(--text-secondary)", width: "130px", textAlign: "right",
        flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{
        flex: 1, background: "var(--bg-elevated)",
        borderRadius: "2px", height: "12px", overflow: "hidden",
      }}>
        <div style={{
          width: "100%",
          transform: `scaleX(${maxCount > 0 ? count / maxCount : 0})`,
          transformOrigin: "left",
          height: "100%", background: color, borderRadius: "2px",
          transition: "transform 0.3s ease",
        }} />
      </div>
      <span style={{
        fontFamily: "var(--font-mono)", fontSize: "0.68rem",
        color: "var(--text-secondary)", width: "32px", textAlign: "right", flexShrink: 0,
      }}>
        {count}
      </span>
    </div>
  );
}

// ── Daily Cost Chart ───────────────────────────────────────────────────────

function DailyCostChart({ daily }: {
  daily: Array<{ date: string; cost: number; turns: number }>;
}) {
  if (daily.length === 0) return <EmptyNote />;
  const maxCost = Math.max(...daily.map((d) => d.cost), 0.001);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "88px" }}>
        {daily.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${formatCost(d.cost)} · ${d.turns} turns`}
            style={{
              flex: 1,
              height: `${d.cost > 0 ? Math.max((d.cost / maxCost) * 100, 2) : 0}%`,
              background: "var(--accent)",
              opacity: 0.7,
              borderRadius: "2px 2px 0 0",
              minWidth: "2px",
              cursor: "default",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = "0.7")}
          />
        ))}
      </div>
      <div style={{ height: "1px", background: "var(--border-subtle)", marginBottom: "5px" }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.61rem", color: "var(--text-muted)" }}>
          {daily[0]?.date}
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.61rem", color: "var(--text-muted)" }}>
          {daily[daily.length - 1]?.date}
        </span>
      </div>
    </div>
  );
}

// ── By-Project breakdown view ──────────────────────────────────────────────

const ALL_CATEGORIES: CategoryType[] = [
  "Coding", "Feature Dev", "Refactoring", "Testing", "Debugging",
  "Build/Deploy", "Git Ops", "Planning", "Brainstorming",
  "Exploration", "Delegation", "Conversation", "General",
];

function ProjectBreakdownView({
  projectDetails,
}: {
  projectDetails: ProjectDetail[];
}) {
  const [focusCategory, setFocusCategory] = useState<CategoryType | null>(null);

  // Determine which categories are present in the data
  const presentCategories = ALL_CATEGORIES.filter((cat) =>
    projectDetails.some((p) => p.categoryBreakdown.some((c) => c.category === cat))
  );

  // Sort projects by focused category cost, or total cost
  const sorted = [...projectDetails].sort((a, b) => {
    if (focusCategory) {
      const aCost = a.categoryBreakdown.find((c) => c.category === focusCategory)?.cost ?? 0;
      const bCost = b.categoryBreakdown.find((c) => c.category === focusCategory)?.cost ?? 0;
      return bCost - aCost;
    }
    return b.cost - a.cost;
  });

  const maxCost = sorted[0]?.cost ?? 1;

  return (
    <div>
      {/* Category focus selector */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "14px", flexWrap: "wrap" }}>
        <span style={{
          fontSize: "0.6rem", fontWeight: 600, letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--text-muted)",
          fontFamily: "var(--font-body)", whiteSpace: "nowrap", marginRight: "2px",
        }}>
          Sort by
        </span>
        <button
          onClick={() => setFocusCategory(null)}
          style={{
            padding: "3px 8px",
            fontSize: "0.68rem", fontFamily: "var(--font-body)",
            color: !focusCategory ? "var(--text-primary)" : "var(--text-muted)",
            background: !focusCategory ? "var(--bg-elevated)" : "transparent",
            border: "1px solid",
            borderColor: !focusCategory ? "var(--border-default)" : "var(--border-subtle)",
            borderRadius: "var(--radius)", cursor: "pointer", lineHeight: 1,
            transition: "color 0.1s, background 0.1s",
          }}
        >
          Total
        </button>
        {presentCategories.map((cat) => {
          const active = focusCategory === cat;
          const color = categoryColor(cat);
          return (
            <button
              key={cat}
              onClick={() => setFocusCategory(active ? null : cat)}
              style={{
                padding: "3px 8px",
                fontSize: "0.68rem", fontFamily: "var(--font-body)",
                color: active ? color : "var(--text-muted)",
                background: active ? "var(--bg-elevated)" : "transparent",
                border: "1px solid",
                borderColor: active ? "var(--border-default)" : "var(--border-subtle)",
                borderRadius: "var(--radius)", cursor: "pointer", lineHeight: 1,
                transition: "color 0.1s, background 0.1s",
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      {/* Project rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {sorted.map((p) => {
          const displayName = decodeProjectName(p.projectDirName);
          const focusCost = focusCategory
            ? p.categoryBreakdown.find((c) => c.category === focusCategory)?.cost ?? 0
            : null;
          const barMax = focusCategory
            ? sorted[0]?.categoryBreakdown.find((c) => c.category === focusCategory)?.cost ?? maxCost
            : maxCost;

          return (
            <div key={p.projectSlug} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {/* Name */}
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: "0.71rem",
                color: "var(--text-secondary)", width: "160px", textAlign: "right",
                flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {displayName}
              </span>

              {/* Stacked category bar */}
              <div style={{
                flex: 1, height: "12px",
                background: "var(--bg-elevated)", borderRadius: "2px",
                overflow: "hidden", display: "flex",
              }}>
                {focusCategory ? (
                  // Single-category highlight bar
                  <div style={{
                    width: "100%",
                    transform: `scaleX(${barMax > 0 ? (focusCost ?? 0) / barMax : 0})`,
                    transformOrigin: "left",
                    height: "100%",
                    background: categoryColor(focusCategory),
                    transition: "transform 0.3s ease",
                  }} />
                ) : (
                  // Stacked bar — proportional segments for each category
                  p.categoryBreakdown.map((c) => (
                    <div
                      key={c.category}
                      title={`${c.category}: ${formatCostCompact(c.cost)}`}
                      style={{
                        width: `${p.cost > 0 ? (c.cost / p.cost) * 100 : 0}%`,
                        height: "100%",
                        background: categoryColor(c.category),
                        opacity: 0.85,
                        flexShrink: 0,
                      }}
                    />
                  ))
                )}
              </div>

              {/* Cost */}
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: "0.68rem",
                color: "var(--text-secondary)", width: "54px", textAlign: "right", flexShrink: 0,
              }}>
                {focusCategory && focusCost !== null
                  ? formatCostCompact(focusCost)
                  : formatCostCompact(p.cost)}
              </span>

              {/* Top tool + MCP indicator */}
              <div style={{ display: "flex", gap: "4px", alignItems: "center", width: "120px", flexShrink: 0 }}>
                {p.topTools[0] && (
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.62rem",
                    color: "var(--text-muted)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    maxWidth: "80px",
                  }}>
                    {p.topTools[0][0]}
                  </span>
                )}
                {p.mcpCalls > 0 && (
                  <span style={{
                    fontSize: "0.6rem", fontFamily: "var(--font-body)",
                    letterSpacing: "0.05em", textTransform: "uppercase",
                    color: "var(--status-active-text)",
                    background: "var(--status-active-bg)",
                    border: "1px solid var(--status-active-border)",
                    borderRadius: "2px", padding: "1px 4px",
                    flexShrink: 0,
                  }}>
                    MCP
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Category color legend */}
      <div style={{ display: "flex", gap: "14px", marginTop: "14px", flexWrap: "wrap" }}>
        {[
          { label: "Dev", cats: ["Coding", "Feature Dev", "Refactoring"] },
          { label: "Ops", cats: ["Testing", "Debugging", "Build/Deploy", "Git Ops"] },
          { label: "Strategy", cats: ["Planning", "Brainstorming", "Exploration", "Delegation"] },
          { label: "Conversation", cats: ["Conversation", "General"] },
        ].map(({ label, cats }) => {
          const color = categoryColor(cats[0] as CategoryType);
          const hasData = cats.some((cat) =>
            projectDetails.some((p) => p.categoryBreakdown.some((c) => c.category === cat))
          );
          if (!hasData) return null;
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div style={{ width: "10px", height: "10px", borderRadius: "2px", background: color, opacity: 0.85 }} />
              <span style={{ fontSize: "0.62rem", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyNote() {
  return (
    <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", padding: "4px 0", margin: 0 }}>—</p>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────

export function UsageDashboard() {
  const [period, setPeriod] = useState<string>("month");
  const [project, setProject] = useState<string | undefined>(undefined);
  const [breakdownMode, setBreakdownMode] = useState<"aggregate" | "by-project">("aggregate");
  const { data, loading } = useUsage(period, project);
  const { data: allData } = useUsage(period);
  const availableProjects = allData?.byProject ?? data?.byProject ?? [];

  const oneShotAccent: "good" | "warn" | "error" | undefined =
    data && data.oneShot.totalVerifiedTasks > 0
      ? data.oneShot.rate >= 0.8 ? "good"
        : data.oneShot.rate >= 0.5 ? "warn"
        : "error"
      : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>

      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <h1 style={{
          fontSize: "1.1rem", fontWeight: 700,
          color: "var(--text-primary)", fontFamily: "var(--font-body)",
          letterSpacing: "-0.01em", margin: 0,
        }}>
          Usage
        </h1>

        {/* Period switcher */}
        <div style={{
          display: "flex",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}>
          {VALID_PERIODS.map((p, i) => (
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
                borderRight: i < VALID_PERIODS.length - 1 ? "1px solid var(--border-subtle)" : "none",
                cursor: "pointer", lineHeight: 1,
                transition: "color 0.1s, background 0.1s",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Project filter */}
        {availableProjects.length > 1 && (
          project ? (
            <button
              onClick={() => setProject(undefined)}
              style={{
                display: "inline-flex", alignItems: "center", gap: "5px",
                padding: "4px 10px",
                fontSize: "0.71rem", fontFamily: "var(--font-mono)",
                color: "var(--status-active-text)",
                background: "var(--status-active-bg)",
                border: "1px solid var(--status-active-border)",
                borderRadius: "var(--radius)",
                cursor: "pointer", lineHeight: 1,
              }}
            >
              {decodeProjectName(
                availableProjects.find((p) => p.projectSlug === project)?.projectDirName ?? project
              )}
              <span style={{ fontSize: "0.7rem", opacity: 0.7 }}>×</span>
            </button>
          ) : (
            <select
              value=""
              onChange={(e) => setProject(e.target.value || undefined)}
              style={{
                fontSize: "0.72rem", fontFamily: "var(--font-body)",
                color: "var(--text-secondary)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: "5px 8px", cursor: "pointer",
              }}
            >
              <option value="">All projects</option>
              {availableProjects.map((p) => (
                <option key={p.projectSlug} value={p.projectSlug}>
                  {decodeProjectName(p.projectDirName)}
                </option>
              ))}
            </select>
          )
        )}

        <div style={{ flex: 1 }} />

        {/* Breakdown mode toggle */}
        {!project && (
          <div style={{
            display: "flex",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}>
            {([
              { value: "aggregate", icon: AlignJustify, label: "Aggregate" },
              { value: "by-project", icon: Layers, label: "By Project" },
            ] as const).map(({ value, icon: Icon, label }, i) => {
              const active = breakdownMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setBreakdownMode(value)}
                  title={label}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "5px",
                    padding: "5px 10px",
                    fontSize: "0.71rem", fontFamily: "var(--font-body)",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    background: active ? "var(--bg-elevated)" : "transparent",
                    border: "none",
                    borderRight: i === 0 ? "1px solid var(--border-subtle)" : "none",
                    cursor: "pointer", lineHeight: 1,
                    transition: "color 0.1s, background 0.1s",
                  }}
                >
                  <Icon style={{ width: "11px", height: "11px" }} />
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {/* Export buttons */}
        {(["csv", "json"] as const).map((fmt) => (
          <button
            key={fmt}
            onClick={() => {
              const params = new URLSearchParams({ period, format: fmt });
              if (project) params.set("project", project);
              window.open(`/api/usage/export?${params}`, "_blank");
            }}
            style={{
              display: "inline-flex", alignItems: "center", gap: "4px",
              padding: "5px 10px",
              fontSize: "0.68rem", fontFamily: "var(--font-body)",
              textTransform: "uppercase", letterSpacing: "0.05em",
              color: "var(--text-muted)",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer", lineHeight: 1,
              transition: "color 0.1s, border-color 0.1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
              (e.currentTarget as HTMLElement).style.borderColor = "var(--border-default)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              (e.currentTarget as HTMLElement).style.borderColor = "var(--border-subtle)";
            }}
          >
            <Download style={{ width: "10px", height: "10px" }} />
            {fmt.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Loading skeleton ─────────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {[56, 110, 180, 140].map((h, i) => (
            <div key={i} style={{
              height: `${h}px`,
              background: "var(--bg-surface)",
              borderRadius: "var(--radius)",
              animation: "pulse 1.5s ease-in-out infinite",
            }} />
          ))}
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      {data && !loading && (
        <>
          {/* Stats strip */}
          <div style={{
            display: "flex", flexWrap: "wrap",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
          }}>
            <StatCell
              label="Total Cost"
              value={formatCost(data.totalCost)}
              detail={data.period}
            />
            <StatCell
              label="Tokens"
              value={formatTokens(data.totalTokens)}
              detail={`${formatTokens(data.tokens.input)} in · ${formatTokens(data.tokens.output)} out`}
            />
            <StatCell
              label="Sessions"
              value={data.totalSessions}
              detail={`${data.totalTurns} turns`}
            />
            <StatCell
              label="Cache Hit"
              value={`${(data.cacheHitRate * 100).toFixed(1)}%`}
              detail="of input cached"
            />
            <StatCell
              label="1-Shot Rate"
              value={data.oneShot.totalVerifiedTasks > 0
                ? `${(data.oneShot.rate * 100).toFixed(0)}%`
                : "—"}
              detail={data.oneShot.totalVerifiedTasks > 0
                ? `${data.oneShot.oneShotTasks}/${data.oneShot.totalVerifiedTasks} tasks`
                : "no verified tasks"}
              accent={oneShotAccent}
              last
            />
          </div>

          {/* Daily cost chart */}
          <div>
            <SectionHeader label="Daily Cost" />
            <DailyCostChart daily={data.daily} />
          </div>

          {/* ── Aggregate mode ──────────────────────────────────────────── */}
          {(breakdownMode === "aggregate" || !!project) && (
            <>
              {/* By model + by category */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
                <div>
                  <SectionHeader label="By Model" />
                  {data.byModel.length === 0 ? <EmptyNote /> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(() => {
                        const max = Math.max(...data.byModel.map((m) => m.cost));
                        return data.byModel.map((m) => (
                          <CostRow
                            key={m.model}
                            label={m.model.replace(/^claude-/, "")}
                            cost={m.cost}
                            maxCost={max}
                            color="var(--accent)"
                            detail={`${m.turns}t`}
                          />
                        ));
                      })()}
                    </div>
                  )}
                </div>

                <div>
                  <SectionHeader label="By Category" />
                  {data.byCategory.length === 0 ? <EmptyNote /> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(() => {
                        const sorted = data.byCategory
                          .filter((c) => c.cost > 0)
                          .sort((a, b) => b.cost - a.cost);
                        const max = sorted[0]?.cost ?? 1;
                        return sorted.map((c) => (
                          <CostRow
                            key={c.category}
                            label={c.category}
                            cost={c.cost}
                            maxCost={max}
                            color={categoryColor(c.category)}
                            detail={`${c.turns}t`}
                          />
                        ));
                      })()}
                    </div>
                  )}
                </div>
              </div>

              {/* By project (when not scoped) */}
              {!project && data.byProject.length > 1 && (
                <div>
                  <SectionHeader label="By Project" />
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {(() => {
                      const sorted = [...data.byProject].sort((a, b) => b.cost - a.cost).slice(0, 12);
                      const max = sorted[0]?.cost ?? 1;
                      return sorted.map((p) => (
                        <CostRow
                          key={p.projectSlug}
                          label={decodeProjectName(p.projectDirName)}
                          cost={p.cost}
                          maxCost={max}
                          color="var(--text-muted)"
                          detail={`${p.turns}t`}
                        />
                      ));
                    })()}
                  </div>
                </div>
              )}

              {/* Top tools + shell */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
                <div>
                  <SectionHeader label="Top Tools" />
                  {data.topTools.length === 0 ? <EmptyNote /> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(() => {
                        const max = data.topTools[0]?.[1] ?? 1;
                        return data.topTools.slice(0, 10).map(([tool, count]) => (
                          <CountRow
                            key={tool}
                            label={tool}
                            count={count}
                            maxCount={max}
                            color="var(--accent)"
                          />
                        ));
                      })()}
                    </div>
                  )}
                </div>

                <div>
                  <SectionHeader label="Shell Commands" />
                  {data.shellStats.length === 0 ? <EmptyNote /> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {(() => {
                        const max = data.shellStats[0]?.count ?? 1;
                        return data.shellStats.slice(0, 10).map((s) => (
                          <CountRow
                            key={s.binary}
                            label={s.binary}
                            count={s.count}
                            maxCount={max}
                            color="var(--text-secondary)"
                          />
                        ));
                      })()}
                    </div>
                  )}
                </div>
              </div>

              {/* MCP servers */}
              {data.mcpStats.length > 0 && (
                <div>
                  <SectionHeader label="MCP Servers" />
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "10px",
                  }}>
                    {data.mcpStats.map((server) => (
                      <div
                        key={server.server}
                        style={{
                          padding: "12px 14px",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-subtle)",
                          borderRadius: "var(--radius)",
                          display: "flex", flexDirection: "column", gap: "8px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{
                            fontSize: "0.75rem", fontWeight: 600,
                            color: "var(--text-primary)", fontFamily: "var(--font-mono)",
                          }}>
                            {server.server}
                          </span>
                          <span style={{
                            fontSize: "0.62rem", color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                          }}>
                            {server.totalCalls}×
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                          {Object.entries(server.tools)
                            .sort((a, b) => b[1] - a[1])
                            .map(([tool, count]) => (
                              <div key={tool} style={{
                                display: "flex", justifyContent: "space-between", alignItems: "center",
                              }}>
                                <span style={{
                                  fontSize: "0.68rem", color: "var(--text-secondary)",
                                  fontFamily: "var(--font-mono)",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  maxWidth: "160px",
                                }}>
                                  {tool}
                                </span>
                                <span style={{
                                  fontSize: "0.65rem", color: "var(--text-muted)",
                                  fontFamily: "var(--font-mono)", flexShrink: 0, marginLeft: "8px",
                                }}>
                                  {count}
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── By Project mode ──────────────────────────────────────────── */}
          {breakdownMode === "by-project" && !project && (
            <>
              <div>
                <SectionHeader label="By Model" />
                {data.byModel.length === 0 ? <EmptyNote /> : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {(() => {
                      const max = Math.max(...data.byModel.map((m) => m.cost));
                      return data.byModel.map((m) => (
                        <CostRow
                          key={m.model}
                          label={m.model.replace(/^claude-/, "")}
                          cost={m.cost}
                          maxCost={max}
                          color="var(--accent)"
                          detail={`${m.turns}t`}
                        />
                      ));
                    })()}
                  </div>
                )}
              </div>

              <div>
                <SectionHeader label="Project Breakdown" />
                {data.projectDetails.length === 0
                  ? <EmptyNote />
                  : <ProjectBreakdownView projectDetails={data.projectDetails} />
                }
              </div>
            </>
          )}
        </>
      )}

      {!loading && !data && (
        <p style={{
          fontSize: "0.8rem", color: "var(--text-muted)",
          textAlign: "center", padding: "48px 0", margin: 0,
        }}>
          No usage data available.
        </p>
      )}
    </div>
  );
}
