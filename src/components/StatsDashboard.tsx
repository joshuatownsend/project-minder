"use client";

import { useStats } from "@/hooks/useStats";
import { StatCard } from "./stats/StatCard";
import { BarChart } from "./stats/BarChart";
import { HealthBar } from "./stats/HealthBar";
import { Skeleton } from "./ui/skeleton";
import {
  FolderOpen,
  Bot,
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Cpu,
  DollarSign,
  Wrench,
  Activity,
} from "lucide-react";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function StatsDashboard() {
  const { data, loading } = useStats();

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Stats</h1>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const cu = data.claudeUsage;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <Activity className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Stats</h1>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          label="Projects"
          value={data.projectCount}
          icon={<FolderOpen className="h-4 w-4" />}
          detail={data.hiddenCount > 0 ? `${data.hiddenCount} hidden` : undefined}
        />
        <StatCard
          label="Claude Sessions"
          value={data.claudeSessions.total}
          icon={<Bot className="h-4 w-4" />}
          detail={`${data.claudeSessions.projectsWithSessions} projects`}
        />
        <StatCard
          label="Pending TODOs"
          value={data.todoHealth.pending}
          icon={<CheckCircle2 className="h-4 w-4" />}
          detail={`${data.todoHealth.completed} completed`}
        />
        <StatCard
          label="Manual Steps"
          value={data.manualStepsHealth.pending}
          icon={<ClipboardList className="h-4 w-4" />}
          detail={`${data.manualStepsHealth.completed} completed`}
        />
        {cu && (
          <StatCard
            label="Est. Cost"
            value={formatCost(cu.costEstimate)}
            icon={<DollarSign className="h-4 w-4" />}
            detail={`${cu.conversationCount} conversations`}
          />
        )}
      </div>

      {/* Claude Usage Section */}
      {cu && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Claude Code Usage
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Input Tokens"
              value={formatTokens(cu.inputTokens)}
              icon={<Cpu className="h-4 w-4" />}
            />
            <StatCard
              label="Output Tokens"
              value={formatTokens(cu.outputTokens)}
            />
            <StatCard
              label="Cache Read"
              value={formatTokens(cu.cacheReadTokens)}
              detail={`${formatTokens(cu.cacheCreateTokens)} created`}
            />
            <StatCard
              label="Errors"
              value={cu.errorCount}
              detail={`${cu.totalTurns} total turns`}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                Top Tools
              </h3>
              <BarChart data={cu.toolUsage} colorClass="bg-violet-500" />
            </div>
            <div className="rounded-lg border p-4 space-y-3">
              <h3 className="text-sm font-medium">Models Used</h3>
              {cu.modelsUsed.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {cu.modelsUsed.map((m) => (
                    <span
                      key={m}
                      className="text-xs bg-[var(--muted)] px-2 py-1 rounded font-mono"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">No model data</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tech Stack Section */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Tech Stack Distribution</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">Frameworks</h3>
            <BarChart data={data.frameworks} colorClass="bg-emerald-500" />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">ORMs</h3>
            <BarChart data={data.orms} colorClass="bg-blue-500" />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">Styling</h3>
            <BarChart data={data.styling} colorClass="bg-pink-500" />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">External Services</h3>
            <BarChart data={data.services} colorClass="bg-amber-500" />
          </div>
        </div>
      </div>

      {/* Project Health Section */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Project Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">Status Distribution</h3>
            <HealthBar
              segments={[
                { value: data.statuses["active"] || 0, colorClass: "bg-emerald-500", label: "Active" },
                { value: data.statuses["paused"] || 0, colorClass: "bg-amber-500", label: "Paused" },
                { value: data.statuses["archived"] || 0, colorClass: "bg-gray-400", label: "Archived" },
              ]}
            />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              Activity Recency
            </h3>
            <HealthBar
              segments={[
                { value: data.activity.today, colorClass: "bg-emerald-500", label: "Today" },
                { value: data.activity.thisWeek, colorClass: "bg-blue-500", label: "This Week" },
                { value: data.activity.thisMonth, colorClass: "bg-amber-500", label: "This Month" },
                { value: data.activity.older, colorClass: "bg-gray-400", label: "Older" },
                { value: data.activity.none, colorClass: "bg-gray-600", label: "No Activity" },
              ]}
            />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">TODO Completion</h3>
            <HealthBar
              segments={[
                { value: data.todoHealth.completed, colorClass: "bg-emerald-500", label: "Completed" },
                { value: data.todoHealth.pending, colorClass: "bg-amber-500", label: "Pending" },
              ]}
            />
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-medium">Manual Steps</h3>
            <HealthBar
              segments={[
                { value: data.manualStepsHealth.completed, colorClass: "bg-emerald-500", label: "Completed" },
                { value: data.manualStepsHealth.pending, colorClass: "bg-amber-500", label: "Pending" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Database Section */}
      {Object.keys(data.databases).length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Databases</h2>
          <div className="rounded-lg border p-4 max-w-md">
            <BarChart data={data.databases} colorClass="bg-cyan-500" />
          </div>
        </div>
      )}
    </div>
  );
}
