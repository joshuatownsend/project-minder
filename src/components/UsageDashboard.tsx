"use client";

import { useState } from "react";
import { useUsage } from "@/hooks/useUsage";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
] as const;

export function UsageDashboard() {
  const [period, setPeriod] = useState<string>("month");
  const [project, setProject] = useState<string | undefined>(undefined);
  const { data, loading } = useUsage(period, project);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Token Usage</h1>
        <div className="flex items-center gap-3">
          {/* Period toggle */}
          <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
            {PERIODS.map((p) => (
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

          {/* Export buttons */}
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

      {/* Project filter */}
      {data && data.byProject.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">Filter:</span>
          <select
            value={project || ""}
            onChange={(e) => setProject(e.target.value || undefined)}
            className="text-sm rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[var(--foreground)]"
          >
            <option value="">All Projects</option>
            {data.byProject.map((p) => (
              <option key={p.projectSlug} value={p.projectSlug}>
                {p.projectDirName}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-[var(--muted-foreground)]">Loading usage data...</div>
        </div>
      )}

      {/* Dashboard content */}
      {data && !loading && (
        <>
          {/* Summary Cards — placeholder, will be replaced by SummaryCards component */}
          <div className="grid grid-cols-4 gap-4" id="summary-cards">
            <div className="rounded-lg border bg-[var(--card)] p-4 space-y-1">
              <span className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Total Cost</span>
              <p className="text-2xl font-bold font-mono">${data.totalCost.toFixed(2)}</p>
              <p className="text-xs text-[var(--muted-foreground)]">{data.period}</p>
            </div>
            <div className="rounded-lg border bg-[var(--card)] p-4 space-y-1">
              <span className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Total Tokens</span>
              <p className="text-2xl font-bold font-mono">{formatNumber(data.totalTokens)}</p>
              <p className="text-xs text-[var(--muted-foreground)]">{data.totalSessions} sessions</p>
            </div>
            <div className="rounded-lg border bg-[var(--card)] p-4 space-y-1">
              <span className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Cache Hit Rate</span>
              <p className="text-2xl font-bold font-mono">{(data.cacheHitRate * 100).toFixed(1)}%</p>
              <p className="text-xs text-[var(--muted-foreground)]">of input tokens cached</p>
            </div>
            <div className="rounded-lg border bg-[var(--card)] p-4 space-y-1">
              <span className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">One-Shot Rate</span>
              <p className="text-2xl font-bold font-mono">{(data.oneShot.rate * 100).toFixed(1)}%</p>
              <p className="text-xs text-[var(--muted-foreground)]">{data.oneShot.oneShotTasks}/{data.oneShot.totalVerifiedTasks} tasks</p>
            </div>
          </div>

          {/* Daily cost chart */}
          <div className="rounded-lg border bg-[var(--card)] p-4" id="daily-chart">
            <h3 className="text-sm font-medium mb-3">Daily Cost</h3>
            <div className="flex items-end gap-1 h-32">
              {data.daily.map((d) => {
                const maxCost = Math.max(...data.daily.map((b) => b.cost), 0.01);
                return (
                  <div
                    key={d.date}
                    className="flex-1 bg-blue-500 rounded-t opacity-80 hover:opacity-100 transition-opacity"
                    style={{ height: `${(d.cost / maxCost) * 100}%`, minHeight: d.cost > 0 ? "2px" : "0" }}
                    title={`${d.date}: $${d.cost.toFixed(2)} | ${d.turns} turns`}
                  />
                );
              })}
            </div>
            {data.daily.length > 0 && (
              <div className="flex justify-between mt-1">
                <span className="text-xs text-[var(--muted-foreground)]">{data.daily[0]?.date}</span>
                <span className="text-xs text-[var(--muted-foreground)]">{data.daily[data.daily.length - 1]?.date}</span>
              </div>
            )}
          </div>

          {/* Breakdown charts — 3 column grid */}
          <div className="grid grid-cols-3 gap-4" id="breakdowns">
            {/* By Model */}
            <div className="rounded-lg border bg-[var(--card)] p-4">
              <h3 className="text-sm font-medium mb-3">By Model</h3>
              <div className="space-y-1.5">
                {data.byModel.map((m) => {
                  const max = data.byModel[0]?.cost || 1;
                  return (
                    <div key={m.model} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{m.model.replace(/^claude-/, "")}</span>
                      <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
                        <div className="bg-violet-500 h-4 rounded-full" style={{ width: `${(m.cost / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono w-16 text-right shrink-0">${m.cost.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* By Project */}
            {!project && (
              <div className="rounded-lg border bg-[var(--card)] p-4">
                <h3 className="text-sm font-medium mb-3">By Project</h3>
                <div className="space-y-1.5">
                  {data.byProject.slice(0, 10).map((p) => {
                    const max = data.byProject[0]?.cost || 1;
                    return (
                      <div key={p.projectSlug} className="flex items-center gap-2">
                        <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{p.projectSlug}</span>
                        <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
                          <div className="bg-emerald-500 h-4 rounded-full" style={{ width: `${(p.cost / max) * 100}%` }} />
                        </div>
                        <span className="text-xs font-mono w-16 text-right shrink-0">${p.cost.toFixed(2)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* By Category */}
            <div className={`rounded-lg border bg-[var(--card)] p-4 ${!project ? "" : "col-span-2"}`}>
              <h3 className="text-sm font-medium mb-3">By Category</h3>
              <div className="space-y-1.5">
                {data.byCategory.map((c) => {
                  const max = data.byCategory[0]?.cost || 1;
                  return (
                    <div key={c.category} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{c.category}</span>
                      <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
                        <div className="bg-blue-500 h-4 rounded-full" style={{ width: `${(c.cost / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono w-16 text-right shrink-0">${c.cost.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Tools + Shell — 2 column */}
          <div className="grid grid-cols-2 gap-4" id="tools">
            <div className="rounded-lg border bg-[var(--card)] p-4">
              <h3 className="text-sm font-medium mb-3">Top Tools</h3>
              <div className="space-y-1.5">
                {data.topTools.slice(0, 10).map(([name, count]) => {
                  const max = data.topTools[0]?.[1] || 1;
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{name}</span>
                      <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
                        <div className="bg-cyan-500 h-4 rounded-full" style={{ width: `${(count / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono w-8 text-right shrink-0">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border bg-[var(--card)] p-4">
              <h3 className="text-sm font-medium mb-3">Shell Commands</h3>
              <div className="space-y-1.5">
                {data.shellStats.slice(0, 10).map((s) => {
                  const max = data.shellStats[0]?.count || 1;
                  return (
                    <div key={s.binary} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--muted-foreground)] w-28 truncate text-right shrink-0">{s.binary}</span>
                      <div className="flex-1 bg-[var(--muted)] rounded-full h-4 overflow-hidden">
                        <div className="bg-amber-500 h-4 rounded-full" style={{ width: `${(s.count / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-mono w-8 text-right shrink-0">{s.count}</span>
                    </div>
                  );
                })}
                {data.shellStats.length === 0 && (
                  <p className="text-sm text-[var(--muted-foreground)]">No shell commands</p>
                )}
              </div>
            </div>
          </div>

          {/* MCP Servers */}
          {data.mcpStats.length > 0 && (
            <div className="rounded-lg border bg-[var(--card)] p-4" id="mcp">
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

      {/* Empty state */}
      {!loading && !data && (
        <div className="flex items-center justify-center py-20">
          <div className="text-[var(--muted-foreground)]">No usage data available</div>
        </div>
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
