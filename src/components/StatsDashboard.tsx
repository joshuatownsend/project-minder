"use client";

import dynamic from "next/dynamic";
import { useStats } from "@/hooks/useStats";
import { BarChart } from "./stats/BarChart";
import { HealthBar } from "./stats/HealthBar";
import { Skeleton } from "./ui/skeleton";
import { StatCell } from "./ui/StatCell";

const SessionComplexityChart = dynamic(
  () => import("./viz/SessionComplexityChart").then((m) => m.SessionComplexityChart),
  { ssr: false, loading: () => <Skeleton className="h-96" /> }
);
import { FolderOpen, Bot, CheckCircle2, ClipboardList, DollarSign, Cpu } from "lucide-react";
import { ChartBlock } from "./stats/ChartBlock";
import { EditAcceptanceCard } from "./stats/EditAcceptanceCard";
import { ToolLatencyCard } from "./stats/ToolLatencyCard";
import { TokenUsageCard } from "./stats/TokenUsageCard";
import { CacheEfficiencyCard } from "./stats/CacheEfficiencyCard";
import { HookActivityCard } from "./stats/HookActivityCard";
import { PressurePanel } from "./stats/PressurePanel";
import { ContextOverheadPanel } from "./ContextOverheadPanel";

import { formatCost, formatTokens } from "@/lib/format";
import { useCurrency } from "@/hooks/useCurrency";
import type { StatsCrossCheck } from "@/lib/scanner/claudeStats";

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

// ── Cross-check card: our totals vs Claude Code's own stats-cache.json ─────────
function driftTone(ratio: number | null): string {
  if (ratio === null) return "var(--text-muted)";
  const a = Math.abs(ratio);
  if (a < 0.05) return "var(--status-active-text)"; // agree (<5%)
  if (a < 0.2) return "var(--accent)"; // mild drift
  return "var(--status-error-text)"; // large drift
}
function fmtDrift(ratio: number | null): string {
  if (ratio === null) return "—";
  const pct = ratio * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 10 && pct % 1 !== 0 ? 1 : 0)}%`;
}

function CrossCheckRow({
  label, ours, claude, ratio,
}: {
  label: string; ours: number; claude: number | null; ratio: number | null;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
      <span style={{ color: "var(--text-muted)", minWidth: "8ch" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{ours.toLocaleString()}</span>
      <span style={{ color: "var(--text-muted)" }}>ours</span>
      <span style={{ color: "var(--border-default)" }}>·</span>
      <span style={{ color: "var(--text-primary)" }}>{claude === null ? "—" : claude.toLocaleString()}</span>
      <span style={{ color: "var(--text-muted)" }}>Claude</span>
      <span style={{ marginLeft: "auto", fontWeight: 600, color: driftTone(ratio) }}>{fmtDrift(ratio)}</span>
    </div>
  );
}

function CrossCheckCard({ cc }: { cc: StatsCrossCheck }) {
  return (
    <div style={{
      background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)", padding: "12px 16px",
      display: "flex", flexDirection: "column", gap: "8px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "0.66rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Cross-check vs Claude&apos;s stats-cache
        </span>
        {cc.lastComputedDate && (
          <span style={{ marginLeft: "auto", fontSize: "0.64rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            computed {cc.lastComputedDate}
          </span>
        )}
      </div>
      <CrossCheckRow label="Sessions" ours={cc.observedSessions} claude={cc.claudeSessions} ratio={cc.sessionDriftRatio} />
      <CrossCheckRow label="Messages" ours={cc.observedMessages} claude={cc.claudeMessages} ratio={cc.messageDriftRatio} />
      <p style={{ fontSize: "0.64rem", color: "var(--text-muted)", margin: 0, lineHeight: 1.4 }}>
        Drift compares our independently-parsed totals to Claude Code&apos;s own counter — a large gap means the two disagree.
      </p>
    </div>
  );
}

// Stat cells now use the shared primitive — see src/components/ui/StatCell.tsx.
// StatsDashboard call sites pass `size="feature"` for the larger marquee
// treatment used on the landing-page stats strips.

export function StatsDashboard() {
  const { data, loading } = useStats();
  const { currency, fxRate } = useCurrency();

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
          <StatCell size="feature"
            label="Projects"
            value={data.projectCount}
            icon={<FolderOpen style={{ width: "13px", height: "13px" }} />}
            detail={data.hiddenCount > 0 ? `${data.hiddenCount} hidden` : undefined}
          />
          <StatCell size="feature"
            label="Sessions"
            value={data.claudeSessions.total}
            icon={<Bot style={{ width: "13px", height: "13px" }} />}
            detail={`${data.claudeSessions.projectsWithSessions} projects`}
          />
          <StatCell size="feature"
            label="Pending TODOs"
            value={data.todoHealth.pending}
            icon={<CheckCircle2 style={{ width: "13px", height: "13px" }} />}
            detail={`${data.todoHealth.completed} done`}
          />
          <StatCell size="feature"
            label="Manual Steps"
            value={data.manualStepsHealth.pending}
            icon={<ClipboardList style={{ width: "13px", height: "13px" }} />}
            detail={`${data.manualStepsHealth.completed} done`}
          />
          {cu ? (
            <StatCell size="feature"
              label="Est. Cost"
              value={formatCost(cu.costEstimate, currency, fxRate)}
              icon={<DollarSign style={{ width: "13px", height: "13px" }} />}
              detail={`${cu.conversationCount} conversations`}
              last
            />
          ) : (
            <StatCell size="feature" label="Est. Cost" value="—" last />
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
              <StatCell size="feature"
                label="Input"
                value={formatTokens(cu.inputTokens)}
                icon={<Cpu style={{ width: "13px", height: "13px" }} />}
              />
              <StatCell size="feature"
                label="Output"
                value={formatTokens(cu.outputTokens)}
              />
              <StatCell size="feature"
                label="Cache Read"
                value={formatTokens(cu.cacheReadTokens)}
                detail={`${formatTokens(cu.cacheCreateTokens)} written`}
              />
              <StatCell size="feature"
                label="Turns"
                value={cu.totalTurns}
                detail={`${cu.errorCount} errors`}
                last
              />
            </div>

            {/* Cross-check vs Claude Code's own stats-cache.json (item 2) */}
            {data.crossCheck?.available && <CrossCheckCard cc={data.crossCheck} />}

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

      {/* Config Lint */}
      {data.configLint && (
        <section>
          <SectionHeader label="Config Lint" />
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex" }}>
              <StatCell size="feature" label="Total Findings" value={String(data.configLint.totalFindings)} />
              <StatCell size="feature" label="P0" value={String(data.configLint.bySeverity.P0)} accent="error" />
              <StatCell size="feature" label="P1" value={String(data.configLint.bySeverity.P1)} accent="warn" />
              <StatCell size="feature" label="P2" value={String(data.configLint.bySeverity.P2)} />
              <StatCell size="feature" label="Projects Affected" value={String(data.configLint.projectsWithFindings)} last />
            </div>
            {Object.keys(data.configLint.byTarget).length > 0 && (
              <ChartBlock title="Findings by Target">
                <BarChart data={Object.fromEntries(
                  Object.entries(data.configLint.byTarget).map(([k, v]) => [k, v ?? 0])
                )} color="var(--accent)" />
              </ChartBlock>
            )}
          </div>
        </section>
      )}

      {/* Session Complexity */}
      {data.sessions && data.sessions.length > 0 && (
        <section>
          <SectionHeader label="Session Complexity" />
          <SessionComplexityChart sessions={data.sessions} />
        </section>
      )}

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

      {/* Context Overhead */}
      <section id="context-overhead">
        <SectionHeader label="Context Overhead" />
        <div
          style={{
            padding: "16px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            background: "var(--bg-surface)",
          }}
        >
          <ContextOverheadPanel />
        </div>
      </section>

      {/* Telemetry */}
      <section id="telemetry">
        <SectionHeader label="Telemetry" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <ChartBlock title="Edit Acceptance">
            <EditAcceptanceCard />
          </ChartBlock>
          <ChartBlock title="Tool Latency">
            <ToolLatencyCard />
          </ChartBlock>
          <ChartBlock title="Token Usage">
            <TokenUsageCard />
          </ChartBlock>
          <ChartBlock title="Cache Efficiency">
            <CacheEfficiencyCard />
          </ChartBlock>
          <ChartBlock title="Hook Activity">
            <HookActivityCard />
          </ChartBlock>
          <div /> {/* spacer */}
        </div>
        <div style={{ marginTop: "16px" }}>
          <ChartBlock title="Pressure">
            <PressurePanel />
          </ChartBlock>
        </div>
      </section>
    </div>
  );
}
