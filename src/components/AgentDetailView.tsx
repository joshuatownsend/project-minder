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
import type { AgentEntry } from "@/lib/indexer/types";
import type { ItemUsageStats } from "./ItemUsageBreakdown";
import type { UsagePeriod } from "@/lib/usage/period";

interface AgentDetailResponse {
  entry: AgentEntry;
  bodyFull: string;
  usage?: ItemUsageStats;
  period: UsagePeriod;
}

interface Props {
  id: string;
}

export function AgentDetailView({ id }: Props) {
  const [data, setData] = useState<AgentDetailResponse | null>(null);
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
    // Clear stale agent details when navigating between ids — otherwise
    // the `if (loading && !data)` gate below keeps showing the previous
    // agent's body/usage under the new URL until the fetch resolves
    // (Codex P2 on PR #113). Period-only changes preserve `data` so
    // the user doesn't see a skeleton flash on every toggle click.
    if (prevIdRef.current !== id) {
      setData(null);
      prevIdRef.current = id;
    }

    fetch(`/api/agents/${encodeURIComponent(id)}?period=${period}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as AgentDetailResponse;
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
      <NotFoundPanel backHref="/agents" backLabel="Agents" message={`Agent "${id}" not found.`} />
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
      <BackLink href="/agents" label="Back to agents" />

      <DetailHeader
        name={entry.name}
        description={entry.description}
        provenance={<ProvenanceBadge provenance={entry.provenance} />}
        meta={
          <>
            {entry.model && (
              <MetaPill label="model" value={entry.model} />
            )}
            {entry.tools && entry.tools.length > 0 && (
              <MetaPill label="tools" value={`${entry.tools.length}`} title={entry.tools.join(", ")} />
            )}
            {entry.category && <MetaPill label="category" value={entry.category} />}
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
            extraSections={
              entry.tools && entry.tools.length > 0 ? (
                <Section label="Tools">
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                    {entry.tools.join(", ")}
                  </code>
                </Section>
              ) : null
            }
          />
        </TabsContent>
        <TabsContent value="body">
          <BodyTab content={bodyFull || entry.bodyExcerpt} filePath={entry.filePath} />
        </TabsContent>
        <TabsContent value="usage">
          <ItemUsageBreakdown
            usage={usage}
            showCost
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
