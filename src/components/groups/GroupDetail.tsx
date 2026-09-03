"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Github } from "lucide-react";
import { StatCell } from "@/components/ui/StatCell";
import { aggregateGroup, type Divergence, type RepoFact } from "@/lib/groups/aggregate";
import { locationLabels } from "@/lib/groups/labels";
import type { ProjectGroup } from "@/lib/groups/types";
import type { ProjectData } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { DivergenceChip, LocationChip, PresenceChips, type Labels } from "./PresenceChips";
import { LocationsStrip } from "./LocationsStrip";
import { GroupBoardTab, GroupInsightsTab, GroupManualStepsTab, GroupOpsTab, GroupTodosTab } from "./GroupRepoTabs";
import { GroupCostsTab } from "./GroupCostsTab";
import { GroupSessionsTab } from "./GroupSessionsTab";
import { EnvironmentsTab } from "./EnvironmentsTab";

type TabKey =
  | "overview"
  | "todos"
  | "insights"
  | "board"
  | "manual-steps"
  | "ops"
  | "costs"
  | "sessions"
  | "environments";

/**
 * `/group/<slug>` — one repo, several checkouts.
 *
 * Aggregates client-side from the members the page already holds (the
 * `ScanResult` from `/api/projects`): `aggregateGroup()` is pure and
 * client-safe by design, so no group API exists. Tabs mirror
 * `ProjectDetail`'s hand-rolled bar; repo-borne tabs render the merged copy
 * with divergence chips, Costs and Sessions show the sum with a per-location
 * split, Environments diffs the Claude homes the locations live under.
 *
 * Session-derived tabs hide in demo mode, like the project page's
 * session-analysis tabs: fixtures have no real sessions or homes behind them.
 */
export function GroupDetail({
  group,
  members,
  skippedRootPaths,
}: {
  group: ProjectGroup;
  members: ProjectData[];
  skippedRootPaths: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const aggregate = useMemo(() => aggregateGroup(members, { skippedRootPaths }), [members, skippedRootPaths]);
  const labels: Labels = useMemo(() => {
    const byPath = locationLabels(members.map((m) => m.path));
    return Object.fromEntries(members.map((m) => [m.slug, byPath.get(m.path) ?? m.slug]));
  }, [members]);
  const memberSlugs = useMemo(() => aggregate.locations.map((l) => l.slug), [aggregate]);
  const demo = members.some((m) => m.demo);
  const remoteUrl = members.find((m) => m.git?.remoteUrl)?.git?.remoteUrl;

  const tabs = useMemo(() => {
    const out: { key: TabKey; label: string }[] = [{ key: "overview", label: "Overview" }];
    if (aggregate.todos) out.push({ key: "todos", label: "TODOs" });
    if (aggregate.insights) out.push({ key: "insights", label: "Insights" });
    if (aggregate.board) out.push({ key: "board", label: "Board" });
    if (aggregate.manualSteps) out.push({ key: "manual-steps", label: "Manual Steps" });
    if (aggregate.operations) out.push({ key: "ops", label: "Ops" });
    out.push({ key: "costs", label: "Costs" });
    if (!demo && aggregate.activity.sessionCount > 0) out.push({ key: "sessions", label: "Sessions" });
    if (!demo) out.push({ key: "environments", label: "Environments" });
    return out;
  }, [aggregate, demo]);

  const initialTab = (searchParams.get("tab") ?? "overview") as TabKey;
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
      router.replace(`/group/${group.slug}?tab=${tab}`, { scroll: false });
    },
    [router, group.slug]
  );

  // Deep-link guard (same as ProjectDetail): a `?tab=` naming a tab this
  // group does not show falls back to Overview rather than rendering nothing.
  useEffect(() => {
    if (!tabs.some((t) => t.key === activeTab)) handleTabChange("overview");
  }, [tabs, activeTab, handleTabChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* ── Nav row ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingBottom: "20px" }}>
        <Link
          href="/projects"
          style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.72rem", color: "var(--text-secondary)", textDecoration: "none" }}
        >
          <ArrowLeft style={{ width: "12px", height: "12px" }} />
          Projects
        </Link>
        <span style={{ fontSize: "0.72rem", color: "var(--border-default)" }}>/</span>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          group · {group.name}
        </span>
      </div>

      {/* ── Header block ────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "18px 24px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius) var(--radius) 0 0",
          borderBottom: "none",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "1.15rem", fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-body)", letterSpacing: "-0.01em", margin: 0 }}>
            {group.name}
          </h1>
          <span
            title={aggregate.locations.map((l) => l.path).join("\n")}
            style={{ fontSize: "0.68rem", fontFamily: "var(--font-mono)", color: "var(--info)", background: "var(--info-bg)", padding: "1px 5px", borderRadius: "3px" }}
          >
            {aggregate.memberCount} locations
          </span>
          {aggregate.partial && (
            <DivergenceChip title="A location's scan root was skipped this pass; its values are carried forward from an earlier scan">
              partial
            </DivergenceChip>
          )}
          {aggregate.divergences.length > 0 && (
            <DivergenceChip title="Repo-borne files disagree between locations — see Overview">
              {aggregate.divergences.length} divergence{aggregate.divergences.length === 1 ? "" : "s"}
            </DivergenceChip>
          )}
          <div style={{ flex: 1 }} />
          {remoteUrl && (
            <a
              href={remoteUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.68rem", color: "var(--text-secondary)", textDecoration: "none", fontFamily: "var(--font-body)" }}
            >
              <Github style={{ width: "10px", height: "10px" }} />
              GitHub
            </a>
          )}
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }} title="Normalized remote — the group's identity">
          {group.key}
        </span>
      </div>

      {/* ── Tab section ─────────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderTop: "1px solid var(--border-default)",
          borderRadius: "0 0 var(--radius) var(--radius)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "0 4px", borderBottom: "1px solid var(--border-subtle)", overflowX: "auto" }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              style={{
                padding: "10px 14px",
                fontSize: "0.72rem",
                fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                fontWeight: activeTab === tab.key ? 600 : 400,
                color: activeTab === tab.key ? "var(--text-primary)" : "var(--text-secondary)",
                background: "transparent",
                border: "none",
                borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer",
                lineHeight: 1,
                transition: "color 0.1s",
                marginBottom: "-1px",
                whiteSpace: "nowrap",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ padding: "20px 24px" }}>
          {activeTab === "overview" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              <LocationsStrip locations={aggregate.locations} members={members} labels={labels} primary={aggregate.primary} />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
                <StatCell label="Sessions" value={aggregate.activity.sessionCount.toLocaleString()} detail="summed across locations" />
                <StatCell
                  label="Last session"
                  value={aggregate.activity.lastSessionDate ? formatRelativeTime(aggregate.activity.lastSessionDate) : "—"}
                  detail={aggregate.activity.mostRecent ? labels[aggregate.activity.mostRecent.slug] : undefined}
                />
                <StatCell
                  label="Last activity"
                  value={aggregate.activity.lastActivity ? formatRelativeTime(aggregate.activity.lastActivity) : "—"}
                  detail={`headline from ${labels[aggregate.primary] ?? aggregate.primary}`}
                />
                <StatCell label="Open TODOs" value={(aggregate.todos?.pending ?? 0).toLocaleString()} detail="deduplicated" />
                <StatCell label="Pending steps" value={(aggregate.manualSteps?.pendingSteps ?? 0).toLocaleString()} detail="deduplicated" />
              </div>

              <section>
                <SectionLabel>Repo facts</SectionLabel>
                <FactRow label="Framework" fact={aggregate.facts.framework} memberSlugs={memberSlugs} labels={labels} />
                <FactRow label="Version" fact={aggregate.facts.frameworkVersion} memberSlugs={memberSlugs} labels={labels} />
                <FactRow label="CLAUDE.md" fact={aggregate.facts.claudeMdSummary} memberSlugs={memberSlugs} labels={labels} />
              </section>

              <section>
                <SectionLabel>Divergences</SectionLabel>
                {aggregate.divergences.length === 0 ? (
                  <p style={{ fontSize: "0.76rem", color: "var(--text-muted)", fontFamily: "var(--font-body)", margin: 0 }}>
                    Every repo-borne file agrees across locations.
                  </p>
                ) : (
                  <DivergenceList divergences={aggregate.divergences} labels={labels} />
                )}
              </section>
            </div>
          )}

          {activeTab === "todos" && aggregate.todos && <GroupTodosTab todos={aggregate.todos} memberSlugs={memberSlugs} labels={labels} />}
          {activeTab === "insights" && aggregate.insights && (
            <GroupInsightsTab insights={aggregate.insights} memberSlugs={memberSlugs} labels={labels} />
          )}
          {activeTab === "board" && aggregate.board && <GroupBoardTab board={aggregate.board} memberSlugs={memberSlugs} labels={labels} />}
          {activeTab === "manual-steps" && aggregate.manualSteps && (
            <GroupManualStepsTab manualSteps={aggregate.manualSteps} memberSlugs={memberSlugs} labels={labels} />
          )}
          {activeTab === "ops" && aggregate.operations && (
            <GroupOpsTab operations={aggregate.operations} memberSlugs={memberSlugs} labels={labels} />
          )}
          {activeTab === "costs" && (
            <GroupCostsTab usageKeys={aggregate.usageKeys} members={members} labels={labels} partial={aggregate.partial} />
          )}
          {activeTab === "sessions" && <GroupSessionsTab activity={aggregate.activity} members={members} labels={labels} />}
          {activeTab === "environments" && <EnvironmentsTab members={members} labels={labels} />}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
      <span style={{ fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontFamily: "var(--font-body)", whiteSpace: "nowrap" }}>
        {children}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
    </div>
  );
}

function FactRow({
  label,
  fact,
  memberSlugs,
  labels,
}: {
  label: string;
  fact: RepoFact<string>;
  memberSlugs: readonly string[];
  labels: Labels;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "4px 0", fontSize: "0.76rem", fontFamily: "var(--font-body)" }}>
      <span style={{ width: "90px", flexShrink: 0, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.68rem" }}>{label}</span>
      <span style={{ color: fact.value ? "var(--text-primary)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
        {fact.value ?? "—"}
      </span>
      {fact.diverged ? (
        <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
          {fact.valueIn.map((v) => (
            <DivergenceChip key={v.slug} title={v.value}>
              {labels[v.slug] ?? v.slug}: {v.value.length > 40 ? `${v.value.slice(0, 40)}…` : v.value}
            </DivergenceChip>
          ))}
        </span>
      ) : (
        <PresenceChips presentIn={fact.valueIn.map((v) => v.slug)} memberSlugs={memberSlugs} labels={labels} />
      )}
    </div>
  );
}

function DivergenceList({ divergences, labels }: { divergences: readonly Divergence[]; labels: Labels }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {divergences.map((d, i) => (
        <div key={`${d.file}|${d.kind}#${i}`} style={{ display: "flex", alignItems: "baseline", gap: "10px", padding: "5px 0", borderTop: i > 0 ? "1px solid var(--border-subtle)" : "none", fontSize: "0.76rem", fontFamily: "var(--font-body)" }}>
          <span style={{ width: "120px", flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-secondary)" }}>{d.file}</span>
          <DivergenceChip>{d.kind === "missing" ? "no content in" : "differs in"}</DivergenceChip>
          <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
            {d.locations.map((slug) => (
              <LocationChip key={slug}>{labels[slug] ?? slug}</LocationChip>
            ))}
          </span>
          <span style={{ color: "var(--text-muted)" }}>{d.detail}</span>
        </div>
      ))}
    </div>
  );
}
