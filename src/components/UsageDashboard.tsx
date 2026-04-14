"use client";

import { useState } from "react";
import { useUsage } from "@/hooks/useUsage";
import { StatCard } from "@/components/stats/StatCard";
import { BarChart } from "@/components/stats/BarChart";
import { VALID_PERIODS } from "@/lib/usage/constants";

export function UsageDashboard() {
  const [period, setPeriod] = useState<string>("month");
  const [project, setProject] = useState<string | undefined>(undefined);
  const { data, loading } = useUsage(period, project);
  // Fetch unfiltered project list so the dropdown stays visible when scoped
  const { data: allData } = useUsage(period);
  const availableProjects = allData?.byProject ?? data?.byProject ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Token Usage</h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            {VALID_PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-3 py-1.5 text-sm transition-colors ${
                  period === p.value
                    ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              const params = new URLSearchParams({ period, format: "csv" });
              if (project) params.set("project", project);
              window.open(`/api/usage/export?${params}`, "_blank");
            }}
            className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams({ period, format: "json" });
              if (project) params.set("project", project);
              window.open(`/api/usage/export?${params}`, "_blank");
            }}
            className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Export JSON
          </button>
        </div>
      </div>

      {availableProjects.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">Filter:</span>
          <select
            value={project || ""}
            onChange={(e) => setProject(e.target.value || undefined)}
            className="text-sm rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[var(--foreground)]"
          >
            <option value="">All Projects</option>
            {availableProjects.map((p) => (
              <option key={p.projectSlug} value={p.projectSlug}>
                {p.projectDirName}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-[var(--muted-foreground)]">Loading usage data...</div>
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-4 gap-4">
            <StatCard
              label="Total Cost"
              value={`$${data.totalCost.toFixed(2)}`}
              detail={data.period}
            />
            <StatCard
              label="Total Tokens"
              value={formatNumber(data.totalTokens)}
              detail={`${data.totalSessions} sessions`}
            />
            <StatCard
              label="Cache Hit Rate"
              value={`${(data.cacheHitRate * 100).toFixed(1)}%`}
              detail="of input tokens cached"
            />
            <StatCard
              label="One-Shot Rate"
              value={`${(data.oneShot.rate * 100).toFixed(1)}%`}
              detail={`${data.oneShot.oneShotTasks}/${data.oneShot.totalVerifiedTasks} tasks`}
            />
          </div>

          {/* Daily cost chart */}
          <div className="rounded-lg border bg-[var(--card)] p-4">
            <h3 className="text-sm font-medium mb-3">Daily Cost</h3>
            {(() => {
              const maxCost = Math.max(...data.daily.map((b) => b.cost), 0.01);
              return (
                <>
                  <div className="flex items-end gap-1 h-32">
                    {data.daily.map((d) => (
                      <div
                        key={d.date}
                        className="flex-1 bg-blue-500 rounded-t opacity-80 hover:opacity-100 transition-opacity"
                        style={{ height: `${(d.cost / maxCost) * 100}%`, minHeight: d.cost > 0 ? "2px" : "0" }}
                        title={`${d.date}: $${d.cost.toFixed(2)} | ${d.turns} turns`}
                      />
                    ))}
                  </div>
                  {data.daily.length > 0 && (
                    <div className="flex justify-between mt-1">
                      <span className="text-xs text-[var(--muted-foreground)]">{data.daily[0]?.date}</span>
                      <span className="text-xs text-[var(--muted-foreground)]">{data.daily[data.daily.length - 1]?.date}</span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Breakdown charts */}
          <div className="grid grid-cols-3 gap-4">
            <ChartCard title="By Model">
              <CostBarChart
                data={Object.fromEntries(data.byModel.map((m) => [m.model.replace(/^claude-/, ""), m.cost]))}
                colorClass="bg-violet-500"
              />
            </ChartCard>

            {!project && (
              <ChartCard title="By Project">
                <CostBarChart
                  data={Object.fromEntries(data.byProject.map((p) => [p.projectSlug, p.cost]))}
                  colorClass="bg-emerald-500"
                />
              </ChartCard>
            )}

            <ChartCard title="By Category" className={project ? "col-span-2" : ""}>
              <CostBarChart
                data={Object.fromEntries(data.byCategory.map((c) => [c.category, c.cost]))}
                colorClass="bg-blue-500"
              />
            </ChartCard>
          </div>

          {/* Tools + Shell */}
          <div className="grid grid-cols-2 gap-4">
            <ChartCard title="Top Tools">
              <BarChart
                data={Object.fromEntries(data.topTools)}
                colorClass="bg-cyan-500"
              />
            </ChartCard>

            <ChartCard title="Shell Commands">
              <BarChart
                data={Object.fromEntries(data.shellStats.map((s) => [s.binary, s.count]))}
                colorClass="bg-amber-500"
              />
            </ChartCard>
          </div>

          {/* MCP Servers */}
          {data.mcpStats.length > 0 && (
            <div className="rounded-lg border bg-[var(--card)] p-4">
              <h3 className="text-sm font-medium mb-3">MCP Servers</h3>
              <div className="grid grid-cols-2 gap-4">
                {data.mcpStats.map((server) => (
                  <div key={server.server} className="rounded border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{server.server}</span>
                      <span className="text-xs text-[var(--muted-foreground)]">{server.totalCalls} calls</span>
                    </div>
                    <div className="space-y-1">
                      {Object.entries(server.tools)
                        .sort((a, b) => b[1] - a[1])
                        .map(([tool, count]) => (
                          <div key={tool} className="flex justify-between text-xs">
                            <span className="text-[var(--muted-foreground)]">{tool}</span>
                            <span className="font-mono">{count}</span>
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

      {!loading && !data && (
        <div className="flex items-center justify-center py-20">
          <div className="text-[var(--muted-foreground)]">No usage data available</div>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border bg-[var(--card)] p-4 ${className}`}>
      <h3 className="text-sm font-medium mb-3">{title}</h3>
      {children}
    </div>
  );
}

function CostBarChart({ data, colorClass }: { data: Record<string, number>; colorClass: string }) {
  const sorted = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sorted.length === 0) return <p className="text-sm text-[var(--muted-foreground)]">No data</p>;
  const max = sorted[0][1];
  return (
    <div className="space-y-1.5">
      {sorted.map(([label, value]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{label}</span>
          <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
            <div className={`${colorClass} h-4 rounded-full`} style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
          </div>
          <span className="text-xs font-mono w-16 text-right shrink-0">${value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
