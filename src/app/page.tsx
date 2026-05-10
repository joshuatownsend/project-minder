"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, AlertTriangle } from "lucide-react";
import {
  Card,
  CardHeader,
  GaugeRing,
  PageHeader,
  Pill,
  ProjectGlyph,
  Seg,
  StackedBars,
  Stat,
  Tag,
} from "@/components/ui/design";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useScope } from "@/components/ScopeProvider";
import { usePulse } from "@/components/PulseProvider";
import type { ProjectData, SessionSummary } from "@/lib/types";
import type { UsageReport } from "@/lib/usage/types";

type Period = "today" | "week" | "month";

interface InsightSummaryItem {
  slug: string;
  insightCount: number;
  topInsightTitle: string | null;
}

interface InsightsResponse {
  results: InsightSummaryItem[];
  total: number;
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
];

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

function projectColor(p: ProjectData, idx: number): string {
  // Stable color per project. Uses an oklch palette that matches dataviz tokens.
  const palette = [
    "var(--info)",
    "var(--good)",
    "var(--accent)",
    "var(--purple)",
    "oklch(0.66 0.14 320)",
    "oklch(0.62 0.10 175)",
    "oklch(0.68 0.14 50)",
    "var(--danger)",
  ];
  // Lightweight deterministic hash so colors are stable across re-renders
  let h = 0;
  for (const ch of p.slug) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return palette[Math.abs(h + idx) % palette.length];
}

export default function HomePage() {
  useDocumentTitle("Home");
  const { scope } = useScope();
  const { snapshot } = usePulse();
  const [period, setPeriod] = useState<Period>("today");

  // We fetch a single broad report (period=month) and slice the daily array
  // client-side to populate the Today / 7-day / 30-day toggle. Going through
  // the API for each period was hitting a UX edge case: the API uses calendar
  // boundaries (week=since-Sunday-midnight, month=since-the-1st), so on a
  // Sunday or the 1st of the month the toggle showed identical numbers
  // because "this week so far" and "today" collapsed to the same range.
  // Rolling windows give meaningful differences regardless of calendar
  // alignment, which matches the labels ("7 days", "30 days").
  const [usageMonth, setUsageMonth] = useState<UsageReport | null>(null);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [insightCount, setInsightCount] = useState<number>(0);
  const [pendingStepsCount, setPendingStepsCount] = useState<number>(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/usage?period=month${scope !== "all" ? `&project=${encodeURIComponent(scope)}` : ""}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUsageMonth(d as UsageReport))
      .catch(() => {});
    return () => ctrl.abort();
  }, [scope]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/projects", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.projects && setProjects(d.projects as ProjectData[]))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/sessions", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.sessions && setSessions((d.sessions as SessionSummary[]).slice(0, 6)))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/insights", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: InsightsResponse | null) => {
        if (!d) return;
        const total = d.results.reduce((s, r) => s + (r.insightCount || 0), 0);
        setInsightCount(total);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/manual-steps?pending=true", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.results) return;
        const total = d.results.reduce(
          (s: number, r: { pendingCount?: number }) => s + (r.pendingCount || 0),
          0,
        );
        setPendingStepsCount(total);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const now = new Date();
  const greeting = timeOfDayGreeting();
  const projectCount = projects.length;
  const liveSessionCount = snapshot.liveSlugs.length;
  const liveProject = liveSessionCount > 0 ? snapshot.liveSlugs[0] : null;

  // Slice the monthly daily array based on the active period toggle.
  // "today" = last 1 entry; "week" = last 7; "month" = full array.
  const periodDays = useMemo(() => {
    if (!usageMonth?.daily?.length) return [];
    const all = usageMonth.daily;
    if (period === "today") return all.slice(-1);
    if (period === "week") return all.slice(-7);
    return all;
  }, [period, usageMonth]);

  // Headline numbers come from the sliced daily buckets so they react to the
  // toggle even when the calendar period (week/month) hasn't started yet.
  const headlineCost = useMemo(
    () => periodDays.reduce((s, d) => s + d.cost, 0),
    [periodDays],
  );
  const headlineTokens = useMemo(
    () => periodDays.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0),
    [periodDays],
  );
  const headlineTurns = useMemo(
    () => periodDays.reduce((s, d) => s + d.turns, 0),
    [periodDays],
  );
  // Cache hit rate is reported globally for the whole period; safe to reuse
  // the API's calendar-month value as a directional indicator. It doesn't
  // need to swing on toggle since cache hit rate barely varies day-to-day.
  const cacheHitRate = usageMonth?.cacheHitRate ?? 0;

  // Health score: simple proxy = 100 - clamp(insights/issues per project)
  const healthScore = useMemo(() => {
    if (!projectCount) return 100;
    const issues = insightCount + pendingStepsCount + (snapshot.approvalCount || 0);
    const ratio = Math.min(1, issues / Math.max(1, projectCount * 4));
    return Math.round(100 - ratio * 100);
  }, [insightCount, pendingStepsCount, projectCount, snapshot.approvalCount]);

  const healthLabel =
    healthScore >= 85 ? "Healthy" : healthScore >= 60 ? "Fair" : healthScore >= 30 ? "Needs work" : "At risk";

  // 7-day chart: last 7 daily buckets from the monthly fetch, [input, output]
  const tokenDays = useMemo(() => {
    if (!usageMonth?.daily?.length) return [];
    const last7 = usageMonth.daily.slice(-7);
    return last7.map((d) => ({
      label: d.date.slice(5).replace("-", "/"),
      values: [d.inputTokens, d.outputTokens],
    }));
  }, [usageMonth]);

  // Sparklines are always last 7 days regardless of toggle — they're a tiny
  // contextual read-out, not a primary metric.
  const costSpark = useMemo(() => {
    if (!usageMonth?.daily?.length) return [];
    return usageMonth.daily.slice(-7).map((d) => d.cost);
  }, [usageMonth]);
  const sessionsSpark = useMemo(() => {
    if (!usageMonth?.daily?.length) return [];
    return usageMonth.daily.slice(-7).map((d) => d.turns);
  }, [usageMonth]);
  const tokensSpark = useMemo(() => {
    if (!usageMonth?.daily?.length) return [];
    return usageMonth.daily.slice(-7).map((d) => d.inputTokens + d.outputTokens);
  }, [usageMonth]);

  // Recent projects = sorted by lastActivity, capped at 6.
  const recentProjects = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });
    return sorted.slice(0, 6);
  }, [projects]);

  // Cost by project. The API's byProject is calendar-period-aligned so we
  // pull it from usageMonth (the broadest fetch) and treat the share as
  // "this month so far". Slicing by rolling-window for byProject is harder
  // since byProject doesn't carry per-day data; the calendar month gives a
  // close-enough portfolio split.
  const costByProject = usageMonth?.byProject?.slice(0, 6) ?? [];
  const costTotal = useMemo(
    () => costByProject.reduce((s, p) => s + p.cost, 0) || 1,
    [costByProject],
  );

  const attentionItems: { tag: "danger" | "warn"; label: string; href: string }[] = [];
  if (snapshot.approvalCount > 0)
    attentionItems.push({ tag: "danger", label: `${snapshot.approvalCount} session${snapshot.approvalCount === 1 ? "" : "s"} awaiting approval`, href: "/status" });
  if (pendingStepsCount > 0)
    attentionItems.push({ tag: "warn", label: `${pendingStepsCount} manual step${pendingStepsCount === 1 ? "" : "s"} pending`, href: "/manual-steps" });
  if (insightCount > 0)
    attentionItems.push({ tag: "warn", label: `${insightCount} insight${insightCount === 1 ? "" : "s"} to review`, href: "/insights" });

  const periodSubtext =
    period === "today" ? `${now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` :
    period === "week" ? "Last 7 days" : "Last 30 days";

  return (
    <div className="shell-content wide">
      <PageHeader
        title={`${greeting}`}
        sub={
          <>
            {projectCount} project{projectCount === 1 ? "" : "s"} · {liveSessionCount} active session{liveSessionCount === 1 ? "" : "s"}
            {liveProject && (
              <>
                {" · "}<span className="live" /> {liveProject} working now
              </>
            )}
            <span style={{ color: "var(--text-4)" }}> · {periodSubtext}</span>
          </>
        }
        right={
          <Seg<Period>
            value={period}
            onChange={setPeriod}
            options={PERIOD_OPTIONS}
          />
        }
      />

      {/* Top stats */}
      <div className="stat-grid">
        <Stat
          label="Spend"
          value={`$${headlineCost.toFixed(2)}`}
          sub={
            period === "today"
              ? "today so far"
              : period === "week"
                ? `last ${periodDays.length || 7} days`
                : `last ${periodDays.length || 30} days`
          }
          accent="var(--accent)"
          spark={costSpark}
          sparkColor="var(--accent)"
          cost
        />
        <Stat
          label="Turns"
          value={formatCount(headlineTurns)}
          sub={liveSessionCount > 0 ? `${liveSessionCount} session${liveSessionCount === 1 ? "" : "s"} active now` : "no active sessions"}
          accent="var(--good)"
          spark={sessionsSpark}
          sparkColor="var(--good)"
        />
        <Stat
          label="Tokens"
          value={formatCount(headlineTokens)}
          sub={`${(cacheHitRate * 100).toFixed(0)}% cache hit`}
          accent="var(--info)"
          spark={tokensSpark}
          sparkColor="var(--info)"
        />
        <Stat
          label="Health score"
          value={`${healthScore}%`}
          sub={`${insightCount} insights · ${pendingStepsCount} steps`}
          accent="var(--danger)"
        />
      </div>

      {/* Attention strip */}
      {attentionItems.length > 0 && (
        <Card
          style={{
            padding: 14,
            marginBottom: 14,
            borderColor: "color-mix(in oklch, var(--danger) 30%, transparent)",
            background: "linear-gradient(90deg, color-mix(in oklch, var(--danger) 6%, transparent), transparent 60%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "color-mix(in oklch, var(--danger) 14%, transparent)",
                color: "var(--danger)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AlertTriangle width={16} height={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Needs attention</div>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
                {attentionItems.map((a, i) => (
                  <Link key={i} href={a.href} style={{ color: "var(--text-2)", textDecoration: "none" }}>
                    <Tag variant={a.tag}>{a.label}</Tag>
                  </Link>
                ))}
              </div>
            </div>
            <Link href="/status" style={{ textDecoration: "none" }}>
              <Pill style={{ height: 30, fontWeight: 600, color: "var(--text)" }}>
                Review <ArrowRight width={12} height={12} />
              </Pill>
            </Link>
          </div>
        </Card>
      )}

      {/* Two columns: chart + activity */}
      <div className="grid-2">
        <Card>
          <CardHeader
            title="Token usage"
            sub="last 7 days"
            right={
              <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--text-3)" }}>
                <span>
                  <span
                    style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--info)", marginRight: 6, verticalAlign: "middle" }}
                  />
                  Input
                </span>
                <span>
                  <span
                    style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--good)", marginRight: 6, verticalAlign: "middle" }}
                  />
                  Output
                </span>
              </div>
            }
          />
          <div style={{ height: 220 }}>
            {tokenDays.length > 0 ? (
              <StackedBars data={tokenDays} height={220} />
            ) : (
              <EmptyChart label="No token data yet" />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Live activity" right={<><span className="live" /><span style={{ fontSize: 11, color: "var(--text-3)" }}>updating</span></>} />
          {sessions.length === 0 ? (
            <EmptyChart label="No recent sessions" />
          ) : (
            <div>
              {sessions.map((s, i) => (
                <div key={s.sessionId} className="list-item">
                  <ProjectGlyph name={s.projectName} color={projectColor({ slug: s.projectSlug } as ProjectData, i)} size={24} />
                  <div className="li-text">
                    <div className="li-title">
                      {s.lastPrompt?.slice(0, 60) || s.initialPrompt?.slice(0, 60) || "(no prompt)"}
                      {s.isActive && <span className="live" style={{ marginLeft: 6 }} />}
                    </div>
                    <div className="li-sub">
                      <span>{s.projectName}</span>
                      <span className="dot" />
                      <span>{s.messageCount} msgs</span>
                    </div>
                  </div>
                  <div className="li-meta">{relativeTime(s.endTime ?? s.startTime)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent projects */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader
          title="Recent projects"
          sub={`${projectCount} total`}
          right={
            <Link href="/projects" style={{ textDecoration: "none" }}>
              <Pill style={{ height: 26 }}>View all <ArrowRight width={12} height={12} /></Pill>
            </Link>
          }
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {recentProjects.length === 0
            ? Array.from({ length: 4 }).map((_, i) => <ProjectTileSkeleton key={i} />)
            : recentProjects.map((p, i) => (
              <Link key={p.slug} href={`/project/${p.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="ds-card" style={{ padding: 14, cursor: "pointer", transition: "border-color .15s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <ProjectGlyph name={p.name} color={projectColor(p, i)} />
                    <div style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p.name}>
                      {p.name}
                    </div>
                    {p.git?.isDirty && p.git.uncommittedCount > 0 && (
                      <Tag variant="warn">+{p.git.uncommittedCount}</Tag>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--text-3)", alignItems: "baseline" }}>
                    <span>
                      <b style={{ color: "var(--text-2)", fontWeight: 600 }}>{p.claude?.sessionCount ?? 0}</b> sessions
                    </span>
                    {p.todos && (
                      <span>
                        <b style={{ color: "var(--text-2)", fontWeight: 600 }}>{p.todos.pending ?? 0}</b> todos
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
                    <IndicatorDot active={p.claude?.mostRecentSessionStatus === "working"} kind="good" title="Active" />
                    <IndicatorDot active={Boolean(p.git?.isDirty)} kind="warn" title="Uncommitted changes" />
                    <IndicatorDot active={(p.manualSteps?.pendingSteps ?? 0) > 0} kind="warn" title={`${p.manualSteps?.pendingSteps ?? 0} steps pending`} />
                    <IndicatorDot active={(p.insights?.total ?? 0) > 0} kind="info" title={`${p.insights?.total ?? 0} insights`} />
                  </div>
                  {p.lastActivity && (
                    <div style={{ fontSize: 10, color: "var(--text-4)", marginTop: 8 }}>{relativeTime(p.lastActivity)}</div>
                  )}
                </div>
              </Link>
            ))}
        </div>
      </Card>

      {/* Cost split + Health */}
      <div className="grid-2">
        <Card>
          <CardHeader
            title="Cost by project"
            sub={`$${costTotal.toFixed(2)} this month`}
          />
          {costByProject.length === 0 ? (
            <EmptyChart label="No cost data for this period" />
          ) : (
            costByProject.map((p, i) => {
              const pct = (p.cost / costTotal) * 100;
              const proj = projects.find((x) => x.slug === p.projectSlug || x.name === p.projectDirName);
              return (
                <div
                  key={p.projectSlug}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}
                >
                  <ProjectGlyph name={proj?.name || p.projectDirName} color={projectColor(proj || ({ slug: p.projectSlug } as ProjectData), i)} size={20} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{proj?.name || p.projectDirName}</span>
                      <span className="mono" style={{ color: "var(--text-3)" }}>
                        ${p.cost.toFixed(2)} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ height: 3, background: "var(--bg-elev-2)", borderRadius: 2 }}>
                      <div style={{ height: "100%", background: projectColor(proj || ({ slug: p.projectSlug } as ProjectData), i), width: `${pct}%`, borderRadius: 2 }} />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </Card>

        <Card>
          <CardHeader
            title="Config health"
            sub={`${insightCount + pendingStepsCount + snapshot.approvalCount} items`}
            right={
              <Link href="/insights" style={{ textDecoration: "none" }}>
                <Pill style={{ height: 26 }}>Open <ArrowRight width={12} height={12} /></Pill>
              </Link>
            }
          />
          <div className="gauge-wrap" style={{ marginBottom: 18 }}>
            <div className="gauge">
              <GaugeRing pct={healthScore} color={healthScore >= 60 ? "var(--good)" : "var(--accent)"} />
              <div className="center">
                <div className="pct">{healthScore}%</div>
                <div className="lab">{healthLabel}</div>
              </div>
            </div>
            <div className="health-cat" style={{ flex: 1 }}>
              <CategoryRow name="Approvals" pct={Math.min(100, snapshot.approvalCount * 25)} color="var(--danger)" count={`${snapshot.approvalCount}`} />
              <CategoryRow name="Manual steps" pct={Math.min(100, pendingStepsCount * 10)} color="var(--warn)" count={`${pendingStepsCount}`} />
              <CategoryRow name="Insights" pct={Math.min(100, insightCount * 5)} color="var(--info)" count={`${insightCount}`} />
              <CategoryRow name="Sessions live" pct={Math.min(100, liveSessionCount * 25)} color="var(--good)" count={`${liveSessionCount}`} />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CategoryRow({ name, pct, color, count }: { name: string; pct: number; color: string; count: string }) {
  return (
    <div className="row">
      <span className="name">{name}</span>
      <div className="bar-wrap">
        <div className="seg-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="count">{count}</span>
    </div>
  );
}

function IndicatorDot({ active, kind, title }: { active: boolean; kind: "good" | "warn" | "danger" | "info"; title: string }) {
  const color = active
    ? kind === "good"   ? "var(--good)"
    : kind === "warn"   ? "var(--warn)"
    : kind === "danger" ? "var(--danger)"
    : "var(--info)"
    : "var(--bg-elev-2)";
  return (
    <span
      title={title}
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        boxShadow: active && kind === "danger" ? "0 0 0 3px color-mix(in oklch, var(--danger) 12%, transparent)" : undefined,
      }}
    />
  );
}

function ProjectTileSkeleton() {
  return (
    <div className="ds-card" style={{ padding: 14, opacity: 0.6 }}>
      <div style={{ height: 14, background: "var(--bg-elev-2)", borderRadius: 4, marginBottom: 10, width: "70%" }} />
      <div style={{ height: 10, background: "var(--bg-elev-2)", borderRadius: 4, width: "40%" }} />
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 100,
        color: "var(--text-3)",
        fontSize: 12,
      }}
    >
      {label}
    </div>
  );
}

function formatCount(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
