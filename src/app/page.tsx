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
import { projectColor } from "@/lib/projectColor";
import type { ProjectData, SessionSummary } from "@/lib/types";
import type { UsageReport } from "@/lib/usage/types";

// Match the standard period vocabulary in src/lib/usage/constants.ts.
// Home doesn't currently surface the 'all' option in the toggle — the
// daily-bucket array is already fetched with period=all and the four-way
// toggle felt like more granularity than this overview surface needs.
type Period = "today" | "7d" | "30d";

// Shape of /api/insights — `{ insights: InsightEntry[], total: number }`.
// Earlier this file declared a non-existent `{ results: …, total }` shape and
// summed over the missing `results` field, which caused HIGH-1/HIGH-2 in the
// 2026-05-10 review (Home insight count permanently stuck at 0).
interface InsightsResponse {
  total: number;
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

function timeOfDayGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

export default function HomePage() {
  useDocumentTitle("Home");
  const { scope } = useScope();
  const { snapshot } = usePulse();
  const [period, setPeriod] = useState<Period>("today");

  // We fetch a single broad report (period=all) and slice the daily array
  // client-side to populate the Today / 7-day / 30-day toggle. The API uses
  // calendar boundaries (week=since-Sunday-midnight, month=since-the-1st),
  // so going through the API for each period meant on a Sunday or the 1st
  // of the month the toggle showed identical numbers. period=all returns
  // the full daily history; client-side slice(-N) gives a true rolling
  // window for any N regardless of calendar alignment, matching the toggle
  // labels ("7 days", "30 days"). Earlier this fetch used period=month
  // which on the 5th of a month meant the "30 days" toggle returned only
  // 5 days of data — copilot flagged the mismatch (PR #102).
  const [usageAll, setUsageAll] = useState<UsageReport | null>(null);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [insightCount, setInsightCount] = useState<number>(0);
  const [pendingStepsCount, setPendingStepsCount] = useState<number>(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/usage?period=all${scope !== "all" ? `&project=${encodeURIComponent(scope)}` : ""}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUsageAll(d as UsageReport))
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

  // Sessions / insights / manual-steps all follow the global scope so the
  // Home attention strip and live-activity feed agree with the scoped
  // headline numbers. Earlier versions fetched once on mount and the
  // attention counts stayed cross-project even while spend/tokens scoped to
  // a single project (PR #102 codex P1).
  useEffect(() => {
    const ctrl = new AbortController();
    const url = `/api/sessions${scope !== "all" ? `?project=${encodeURIComponent(scope)}` : ""}`;
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // /api/sessions returns a JSON array of SessionSummary directly.
        if (!Array.isArray(d)) return;
        setSessions((d as SessionSummary[]).slice(0, 6));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [scope]);

  useEffect(() => {
    const ctrl = new AbortController();
    const url = `/api/insights${scope !== "all" ? `?project=${encodeURIComponent(scope)}` : ""}`;
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: InsightsResponse | null) => {
        if (!d) return;
        setInsightCount(d.total ?? 0);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [scope]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/manual-steps?pending=true", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // /api/manual-steps?pending=true returns an array of project entries
        // shaped { slug, name, manualSteps: { pendingSteps, … } }. The route
        // doesn't accept a project filter, so we filter by scope client-side.
        if (!Array.isArray(d)) return;
        const filtered = scope === "all"
          ? d
          : (d as Array<{ slug?: string }>).filter((p) => p.slug === scope);
        const total = (filtered as Array<{ manualSteps?: { pendingSteps?: number } }>).reduce(
          (s, p) => s + (p.manualSteps?.pendingSteps ?? 0),
          0,
        );
        setPendingStepsCount(total);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [scope]);

  const now = new Date();
  const greeting = timeOfDayGreeting();
  const projectCount = projects.length;
  // Active = working OR waiting-on-user. liveSlugs and awaitingSlugs SHOULD be
  // disjoint (per PulseProvider) but we dedupe through a Set so a backend bug
  // that puts a slug in both lists doesn't double-count (was LOW-4 in review).
  const activeSlugs = useMemo(
    () => Array.from(new Set([...snapshot.liveSlugs, ...snapshot.awaitingSlugs])),
    [snapshot.liveSlugs, snapshot.awaitingSlugs],
  );
  const liveSessionCount = activeSlugs.length;
  const liveProject = activeSlugs[0] ?? null;

  // Slice the full daily array based on the active period toggle.
  // today=last 1, 7d=last 7, 30d=last 30 — true rolling windows that match
  // the toggle labels regardless of where in the calendar month we are.
  const periodDays = useMemo(() => {
    if (!usageAll?.daily?.length) return [];
    const all = usageAll.daily;
    if (period === "today") return all.slice(-1);
    if (period === "7d") return all.slice(-7);
    return all.slice(-30);
  }, [period, usageAll]);

  // Headline numbers come from the sliced daily buckets so they react to
  // the toggle deterministically.
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
  // Cache hit rate is reported globally for the whole period; we keep it as
  // an all-time directional indicator since cache hit rate barely varies
  // day-to-day.
  const cacheHitRate = usageAll?.cacheHitRate ?? 0;

  // Health score: simple proxy = 100 - clamp(insights/issues per project)
  const healthScore = useMemo(() => {
    if (!projectCount) return 100;
    const issues = insightCount + pendingStepsCount + (snapshot.approvalCount || 0);
    const ratio = Math.min(1, issues / Math.max(1, projectCount * 4));
    return Math.round(100 - ratio * 100);
  }, [insightCount, pendingStepsCount, projectCount, snapshot.approvalCount]);

  const healthLabel =
    healthScore >= 85 ? "Healthy" : healthScore >= 60 ? "Fair" : healthScore >= 30 ? "Needs work" : "At risk";

  // Token usage chart matches the active period toggle. For "today" we
  // expand back to the last 3 days so a single bar doesn't sit awkwardly
  // alone — three days gives enough context to read trend at a glance.
  const tokenDays = useMemo(() => {
    if (!usageAll?.daily?.length) return [];
    const slice =
      period === "today" ? usageAll.daily.slice(-3)
      : period === "7d" ? usageAll.daily.slice(-7)
      : usageAll.daily.slice(-30);
    return slice.map((d) => ({
      label: d.date.slice(5).replace("-", "/"),
      values: [d.inputTokens, d.outputTokens],
    }));
  }, [period, usageAll]);

  // Sparklines are always last 7 days regardless of toggle — they're a tiny
  // contextual read-out, not a primary metric.
  const costSpark = useMemo(() => {
    if (!usageAll?.daily?.length) return [];
    return usageAll.daily.slice(-7).map((d) => d.cost);
  }, [usageAll]);
  const sessionsSpark = useMemo(() => {
    if (!usageAll?.daily?.length) return [];
    return usageAll.daily.slice(-7).map((d) => d.turns);
  }, [usageAll]);
  const tokensSpark = useMemo(() => {
    if (!usageAll?.daily?.length) return [];
    return usageAll.daily.slice(-7).map((d) => d.inputTokens + d.outputTokens);
  }, [usageAll]);

  // Recent projects = sorted by lastActivity, capped at 6.
  const recentProjects = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });
    return sorted.slice(0, 6);
  }, [projects]);

  // Cost by project. byProject is the API's portfolio split — we pull it
  // from the all-time fetch and label the card "all-time" to match.
  // Slicing by rolling-window per-project is impractical since byProject
  // doesn't carry per-day data.
  const costByProject = usageAll?.byProject?.slice(0, 6) ?? [];
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
    period === "7d" ? "Last 7 days" : "Last 30 days";

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

      {/* Top stats. While the usage report is still loading we show em-dashes
          rather than zeros so the user doesn't see a brief "you spent $0
          today / 0 turns / 0 tokens / 100% healthy" frame before real data
          swaps in (was MEDIUM-4 in the 2026-05-10 review). */}
      <div className="stat-grid">
        <Stat
          label="Spend"
          value={usageAll === null ? "—" : `$${headlineCost.toFixed(2)}`}
          sub={
            period === "today"
              ? "today so far"
              : period === "7d"
                ? "last 7 days"
                : "last 30 days"
          }
          accent="var(--accent)"
          spark={costSpark}
          sparkColor="var(--accent)"
          cost
        />
        <Stat
          label="Turns"
          value={usageAll === null ? "—" : formatCount(headlineTurns)}
          sub={`${liveSessionCount} active now`}
          accent="var(--good)"
          spark={sessionsSpark}
          sparkColor="var(--good)"
        />
        <Stat
          label="Tokens"
          value={usageAll === null ? "—" : formatCount(headlineTokens)}
          sub={usageAll === null ? "loading…" : `${(cacheHitRate * 100).toFixed(0)}% cache hit`}
          accent="var(--info)"
          spark={tokensSpark}
          sparkColor="var(--info)"
        />
        <Stat
          label="Health score"
          value={usageAll === null ? "—" : `${healthScore}%`}
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
            sub={
              period === "today"
                ? "last 3 days"
                : period === "7d"
                  ? "last 7 days"
                  : "last 30 days"
            }
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
              {sessions.map((s) => (
                <div key={s.sessionId} className="list-item">
                  <ProjectGlyph name={s.projectName} color={projectColor(s.projectSlug)} size={24} />
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
            : recentProjects.map((p) => (
              <Link key={p.slug} href={`/project/${p.slug}`} style={{ textDecoration: "none", color: "inherit" }}>
                <div className="ds-card" style={{ padding: 14, cursor: "pointer", transition: "border-color .15s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <ProjectGlyph name={p.name} color={projectColor(p.slug)} />
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
            sub={`$${costTotal.toFixed(2)} all-time`}
          />
          {costByProject.length === 0 ? (
            <EmptyChart label="No cost data for this period" />
          ) : (
            costByProject.map((p) => {
              const pct = (p.cost / costTotal) * 100;
              const proj = projects.find((x) => x.slug === p.projectSlug || x.name === p.projectDirName);
              const color = projectColor(proj?.slug ?? p.projectSlug);
              return (
                <div
                  key={p.projectSlug}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}
                >
                  <ProjectGlyph name={proj?.name || p.projectDirName} color={color} size={20} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12 }}>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{proj?.name || p.projectDirName}</span>
                      <span className="mono" style={{ color: "var(--text-3)" }}>
                        ${p.cost.toFixed(2)} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div style={{ height: 3, background: "var(--bg-elev-2)", borderRadius: 2 }}>
                      <div style={{ height: "100%", background: color, width: `${pct}%`, borderRadius: 2 }} />
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
