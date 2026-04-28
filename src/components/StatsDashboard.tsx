"use client";

import { useStats } from "@/hooks/useStats";
import { BarChart } from "./stats/BarChart";
import { HealthBar } from "./stats/HealthBar";
import { Skeleton } from "./ui/skeleton";
import { FolderOpen, Bot, CheckCircle2, ClipboardList, DollarSign, Cpu } from "lucide-react";
import type { ReactNode } from "react";

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

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
      <span style={{
        fontSize: "0.62rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

interface StatCellProps {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: ReactNode;
  last?: boolean;
}

function StatCell({ label, value, detail, icon, last }: StatCellProps) {
  return (
    <div style={{
      flex: 1,
      padding: "12px 16px",
      borderRight: last ? "none" : "1px solid var(--border-subtle)",
      display: "flex",
      flexDirection: "column",
      gap: "3px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{
          fontSize: "0.62rem",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}>
          {label}
        </span>
        {icon && <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: "1.35rem", fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.1 }}>
        {value}
      </div>
      {detail && (
        <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {detail}
        </div>
      )}
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }}>
      <span style={{
        fontSize: "0.65rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
      }}>
        {title}
      </span>
      {children}
    </div>
  );
}

export function StatsDashboard() {
  const { data, loading } = useStats();

  if (loading || !data) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
        <div style={{ display: "flex", gap: "0", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} style={{ flex: 1, height: "72px", borderRadius: 0 }} />
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} style={{ height: "120px", borderRadius: "var(--radius)" }} />
          ))}
        </div>
      </div>
    );
  }

  const cu = data.claudeUsage;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>

      {/* Overview strip */}
      <section>
        <SectionHeader label="Overview" />
        <div style={{
          display: "flex",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          background: "var(--bg-surface)",
        }}>
          <StatCell
            label="Projects"
            value={data.projectCount}
            icon={<FolderOpen style={{ width: "13px", height: "13px" }} />}
            detail={data.hiddenCount > 0 ? `${data.hiddenCount} hidden` : undefined}
          />
          <StatCell
            label="Sessions"
            value={data.claudeSessions.total}
            icon={<Bot style={{ width: "13px", height: "13px" }} />}
            detail={`${data.claudeSessions.projectsWithSessions} projects`}
          />
          <StatCell
            label="Pending TODOs"
            value={data.todoHealth.pending}
            icon={<CheckCircle2 style={{ width: "13px", height: "13px" }} />}
            detail={`${data.todoHealth.completed} done`}
          />
          <StatCell
            label="Manual Steps"
            value={data.manualStepsHealth.pending}
            icon={<ClipboardList style={{ width: "13px", height: "13px" }} />}
            detail={`${data.manualStepsHealth.completed} done`}
          />
          {cu ? (
            <StatCell
              label="Est. Cost"
              value={formatCost(cu.costEstimate)}
              icon={<DollarSign style={{ width: "13px", height: "13px" }} />}
              detail={`${cu.conversationCount} conversations`}
              last
            />
          ) : (
            <StatCell label="Est. Cost" value="—" last />
          )}
        </div>
      </section>

      {/* Claude Usage */}
      {cu && (
        <section>
          <SectionHeader label="Claude Usage" />
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {/* Token strip */}
            <div style={{
              display: "flex",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
              background: "var(--bg-surface)",
            }}>
              <StatCell
                label="Input"
                value={formatTokens(cu.inputTokens)}
                icon={<Cpu style={{ width: "13px", height: "13px" }} />}
              />
              <StatCell
                label="Output"
                value={formatTokens(cu.outputTokens)}
              />
              <StatCell
                label="Cache Read"
                value={formatTokens(cu.cacheReadTokens)}
                detail={`${formatTokens(cu.cacheCreateTokens)} written`}
              />
              <StatCell
                label="Turns"
                value={cu.totalTurns}
                detail={`${cu.errorCount} errors`}
                last
              />
            </div>

            {/* Tools + Models */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <ChartBlock title="Top Tools">
                <BarChart data={cu.toolUsage} color="var(--info)" maxItems={8} />
              </ChartBlock>
              <ChartBlock title="Models Used">
                {cu.modelsUsed.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {cu.modelsUsed.map((m) => (
                      <div key={m} style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}>
                        <div style={{
                          width: "5px",
                          height: "5px",
                          borderRadius: "50%",
                          background: "var(--status-active-text)",
                          flexShrink: 0,
                        }} />
                        <span style={{
                          fontSize: "0.75rem",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-secondary)",
                        }}>
                          {m}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>No model data</p>
                )}
              </ChartBlock>
            </div>
          </div>
        </section>
      )}

      {/* Tech Stack */}
      <section>
        <SectionHeader label="Tech Stack" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <ChartBlock title="Frameworks">
            <BarChart data={data.frameworks} color="var(--status-active-text)" />
          </ChartBlock>
          <ChartBlock title="ORMs">
            <BarChart data={data.orms} color="var(--info)" />
          </ChartBlock>
          <ChartBlock title="Styling">
            <BarChart data={data.styling} color="var(--status-error-text)" />
          </ChartBlock>
          <ChartBlock title="External Services">
            <BarChart data={data.services} color="var(--text-secondary)" />
          </ChartBlock>
        </div>
      </section>

      {/* Project Health */}
      <section>
        <SectionHeader label="Project Health" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <ChartBlock title="Status Distribution">
            <HealthBar
              segments={[
                { value: data.statuses["active"] || 0, color: "var(--status-active-text)", label: "Active" },
                { value: data.statuses["paused"] || 0, color: "var(--accent)", label: "Paused" },
                { value: data.statuses["archived"] || 0, color: "var(--text-muted)", label: "Archived" },
              ]}
            />
          </ChartBlock>
          <ChartBlock title="Activity Recency">
            <HealthBar
              segments={[
                { value: data.activity.today, color: "var(--status-active-text)", label: "Today" },
                { value: data.activity.thisWeek, color: "var(--info)", label: "This Week" },
                { value: data.activity.thisMonth, color: "var(--status-error-text)", label: "This Month" },
                { value: data.activity.older, color: "var(--text-muted)", label: "Older" },
                { value: data.activity.none, color: "var(--border-default)", label: "No Activity" },
              ]}
            />
          </ChartBlock>
          <ChartBlock title="TODO Completion">
            <HealthBar
              segments={[
                { value: data.todoHealth.completed, color: "var(--status-active-text)", label: "Completed" },
                { value: data.todoHealth.pending, color: "var(--accent)", label: "Pending" },
              ]}
            />
          </ChartBlock>
          <ChartBlock title="Manual Steps">
            <HealthBar
              segments={[
                { value: data.manualStepsHealth.completed, color: "var(--status-active-text)", label: "Completed" },
                { value: data.manualStepsHealth.pending, color: "var(--accent)", label: "Pending" },
              ]}
            />
          </ChartBlock>
        </div>
      </section>

      {/* Databases */}
      {Object.keys(data.databases).length > 0 && (
        <section>
          <SectionHeader label="Databases" />
          <div style={{ maxWidth: "420px" }}>
            <ChartBlock title="Database Usage">
              <BarChart data={data.databases} color="var(--status-active-text)" />
            </ChartBlock>
          </div>
        </section>
      )}
    </div>
  );
}
