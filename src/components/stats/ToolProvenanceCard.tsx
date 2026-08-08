"use client";

import { useReportFetch } from "@/hooks/useReportFetch";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultSince } from "@/lib/format";
import { describeSourceCoverage } from "@/lib/telemetry/provenanceCoverage";
import type { ToolProvenanceResult } from "@/lib/db/otelCorrelation";

interface Props {
  since?: string;
}

const SOURCE_META: Record<string, { label: string; color: string; explanation: string }> = {
  builtin: {
    label: "built-in",
    color: "var(--info)",
    explanation: "Tools shipped with Claude Code — Read, Edit, Bash and the rest.",
  },
  mcp: {
    label: "MCP",
    color: "var(--accent)",
    explanation: "Tools provided by a connected MCP server.",
  },
  plugin: {
    label: "plugin",
    color: "var(--status-active-text)",
    explanation: "Tools contributed by an installed plugin.",
  },
};

const MONO = { fontFamily: "var(--font-mono)" } as const;

/**
 * Where tools came from, per Claude Code rather than per convention.
 *
 * Minder otherwise infers "is this an MCP call?" from the `mcp__server__tool`
 * naming convention — a convention, not a guarantee, and one that says nothing
 * at all about plugin-provided tools. `tool_source` states it outright, so this
 * card is the ground truth that inference is measured against.
 */
export function ToolProvenanceCard({ since }: Props) {
  const sinceParam = since ?? defaultSince();
  const { data, loading, error } = useReportFetch<ToolProvenanceResult>(
    `/api/telemetry/tool-provenance?since=${encodeURIComponent(sinceParam)}`,
  );

  if (loading) return <Skeleton className="h-32" />;

  if (error) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem" }}>
        Error: {error}
      </div>
    );
  }

  // "No event carries `tool_source`" is a statement about instrumentation, not
  // about your tools. Rendering an empty list would look like "every tool was
  // built-in", which is a different and unsupported claim.
  if (!data?.hasData) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.78rem", lineHeight: 1.6 }}>
        No tool source recorded in this window.
        <br />
        <span style={{ fontSize: "0.72rem" }}>
          Needs OTEL telemetry enabled, on a Claude Code version that emits{" "}
          <code>tool_source</code>.
        </span>
      </div>
    );
  }

  const coverage = describeSourceCoverage(data);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Proportional bar. Only the sources actually observed appear — a fixed
          three-way legend would imply plugin tools were measured and found to
          be zero, when the honest reading is that none were seen. */}
      <div style={{ display: "flex", height: "8px", borderRadius: "3px", overflow: "hidden", background: "var(--bg-elevated)" }}>
        {data.sources.map((s) => (
          <div
            key={s.source}
            title={`${SOURCE_META[s.source]?.label ?? s.source}: ${s.events.toLocaleString()} events`}
            style={{
              width: `${(s.events / Math.max(data.total, 1)) * 100}%`,
              background: SOURCE_META[s.source]?.color ?? "var(--text-muted)",
            }}
          />
        ))}
      </div>

      {data.sources.map((s) => {
        const meta = SOURCE_META[s.source];
        const pct = (s.events / Math.max(data.total, 1)) * 100;
        return (
          <div key={s.source} style={{ display: "flex", alignItems: "baseline", gap: "7px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: meta?.color ?? "var(--text-muted)", flexShrink: 0 }} />
            <span className="sr-only">{meta?.explanation ?? `Tool source: ${s.source}`}</span>
            <span
              aria-hidden="true"
              title={meta?.explanation}
              style={{ ...MONO, fontSize: "0.7rem", color: "var(--text-secondary)", cursor: meta ? "help" : undefined }}
            >
              {meta?.label ?? s.source}
            </span>
            <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--text-primary)", marginLeft: "auto" }}>
              {pct < 1 ? "<1" : Math.round(pct)}%
            </span>
            {/* Units spelled out. "215 in 11" is two unlabelled numbers, and
                the sibling Denials card in this same section says "19 in 10
                sessions" — a reader moving between them should not have to
                infer that the second number means the same thing in both. */}
            <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--text-muted)", minWidth: "12ch", textAlign: "right", whiteSpace: "nowrap" }}>
              {s.events.toLocaleString()} in {s.sessions} {s.sessions === 1 ? "session" : "sessions"}
            </span>
          </div>
        );
      })}

      {/* Coverage, not just the total. The split is computed over events that
          state a source, so on a window predating `tool_source` the
          percentages describe an instrumented subset — a partial answer shaped
          exactly like a complete one. Stated whenever it is not everything. */}
      <div style={{ ...MONO, fontSize: "0.6rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
        {/* The "N of M" form is only meaningful while N ≤ M. If `tool_source`
            ever appears outside the coverage denominator the ratio inverts,
            and "120 of 100 tool calls" is visibly impossible arithmetic — the
            same self-contradiction the truncated percentage avoids. Fall back
            to the bare total there. */}
        {coverage && data.total <= data.callsInWindow
          ? `${data.total.toLocaleString()} of ${data.callsInWindow.toLocaleString()} tool calls state a source`
          : `${data.total.toLocaleString()} tool calls state a source`}
        {coverage?.partial && (
          <>
            {" "}
            (<span style={{ color: "var(--accent)" }}>{coverage.pctLabel}%</span> of this window) — the
            split above describes those, not the rest. Claude Code began reporting tool source partway
            through most indexes; narrow the period for a fully covered view.
          </>
        )}
        <br />
        Source is stated by Claude Code, not inferred from tool names.
      </div>
    </div>
  );
}
