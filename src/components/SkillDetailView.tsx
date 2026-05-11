"use client";

import { useEffect, useRef, useState } from "react";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ProvenanceBadge, ProvenanceDetails } from "./ProvenanceBadge";
import { ItemUsageBreakdown } from "./ItemUsageBreakdown";
import {
  BackLink,
  BodyTab,
  DetailHeader,
  MetaPill,
  NotFoundPanel,
  OverviewTab,
  VersionsTab,
} from "./CatalogItemDetail";
import type { SkillEntry } from "@/lib/indexer/types";
import type { ItemUsageStats } from "./ItemUsageBreakdown";
import type { UsagePeriod } from "@/lib/usage/period";

interface SkillDetailResponse {
  entry: SkillEntry;
  bodyFull: string;
  usage?: ItemUsageStats;
  period: UsagePeriod;
}

interface Props {
  id: string;
}

export function SkillDetailView({ id }: Props) {
  const [data, setData] = useState<SkillDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<UsagePeriod>("all");
  const prevIdRef = useRef(id);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setNotFound(false);
    setError(null);
    // See AgentDetailView for the rationale — clear stale data on id
    // navigation; preserve it on period-only changes (Codex P2 on PR #113).
    if (prevIdRef.current !== id) {
      setData(null);
      prevIdRef.current = id;
    }

    fetch(`/api/skills/${encodeURIComponent(id)}?period=${period}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SkillDetailResponse;
      })
      .then((d) => {
        if (ctrl.signal.aborted) return;
        if (d) setData(d);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });

    return () => ctrl.abort();
  }, [id, period]);

  if (loading && !data) return <Skeleton className="h-96" />;

  if (notFound) {
    return (
      <NotFoundPanel backHref="/skills" backLabel="Skills" message={`Skill "${id}" not found.`} />
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        {error ?? "No data"}
      </div>
    );
  }

  const { entry, bodyFull, usage } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <BackLink href="/skills" label="Back to skills" />

      <DetailHeader
        name={entry.name}
        description={entry.description}
        provenance={<ProvenanceBadge provenance={entry.provenance} />}
        meta={
          <>
            <MetaPill label="layout" value={entry.layout} />
            {entry.userInvocable && <MetaPill label="user-invocable" value="yes" />}
            {entry.disabled && <MetaPill label="status" value="disabled" />}
            {entry.argumentHint && <MetaPill label="args" value={entry.argumentHint} />}
            {entry.version && <MetaPill label="version" value={entry.version} />}
          </>
        }
      />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab
            frontmatter={entry.frontmatter}
            provenanceDetails={<ProvenanceDetails provenance={entry.provenance} />}
          />
        </TabsContent>
        <TabsContent value="body">
          <BodyTab content={bodyFull || entry.bodyExcerpt} filePath={entry.filePath} />
        </TabsContent>
        <TabsContent value="usage">
          <ItemUsageBreakdown
            usage={usage}
            period={period}
            onPeriodChange={setPeriod}
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="versions">
          <VersionsTab provenance={entry.provenance} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

