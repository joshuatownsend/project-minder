"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Skeleton } from "./ui/skeleton";
import { formatTokens } from "@/lib/format";
import { useReportFetch } from "@/hooks/useReportFetch";
import type {
  ContextOverheadBreakdown,
  ContextSource,
  SourceRow,
} from "@/lib/contextOverhead";

/**
 * Portfolio-wide context overhead panel (TODO #135 / Phase 3).
 *
 * Mounted on `/stats`. Each source row is a stacked-bar segment colored
 * by source-kind, with a "manage" deep-link to the relevant browser
 * (skills → /skills, MCP → /config?type=mcp, etc.). The trailing
 * "unaccounted" row only renders when observed > known and represents
 * the residual gap (sub-agents, conversation, unmodeled sources).
 */

const SOURCE_COLORS: Record<ContextSource, string> = {
  baseline: "var(--text-muted)",
  mcp: "var(--info)",
  skills: "var(--status-active-text)",
  hooks: "var(--accent)",
  memory: "var(--status-error-text)",
  unknown: "var(--border-default)",
};

export function ContextOverheadPanel() {
  const { data, loading, error } =
    useReportFetch<ContextOverheadBreakdown>("/api/context-overhead");

  if (loading) return <Skeleton className="h-64" />;

  if (error) {
    return (
      <div
        style={{
          padding: "16px",
          color: "var(--text-muted)",
          fontSize: "0.78rem",
        }}
      >
        Error: {error}
      </div>
    );
  }

  if (!data) return null;

  // Bar denominator: prefer `observedTokens` when we have one (so the
  // "unaccounted" row visibly fills the gap), else fall back to known.
  const total = Math.max(data.observedTokens ?? 0, data.knownTokens, 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <HeaderStrip data={data} />

      <div
        style={{
          display: "flex",
          height: "12px",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          border: "1px solid var(--border-subtle)",
        }}
      >
        {data.rows
          .filter((r) => r.tokens > 0)
          .map((r) => (
            <div
              key={r.source}
              title={`${r.label}: ${formatTokens(r.tokens)} tokens`}
              style={{
                width: `${(r.tokens / total) * 100}%`,
                background: SOURCE_COLORS[r.source],
                minWidth: "2px",
              }}
            />
          ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {data.rows.map((r) => (
          <RowItem key={r.source} row={r} />
        ))}
      </div>

      <Footnote data={data} />
    </div>
  );
}

function HeaderStrip({ data }: { data: ContextOverheadBreakdown }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "10px",
      }}
    >
      <Cell label="Known" value={formatTokens(data.knownTokens)} />
      <Cell
        label="Observed (median)"
        value={
          data.observedTokens === null ? "—" : formatTokens(data.observedTokens)
        }
        detail={
          data.sampleSize > 0
            ? `n=${data.sampleSize}`
            : "no sessions indexed"
        }
      />
      <Cell
        label="Unaccounted"
        value={
          data.unaccountedTokens === null
            ? "—"
            : formatTokens(data.unaccountedTokens)
        }
        emphasis={
          data.unaccountedTokens !== null && data.unaccountedTokens > 0
        }
      />
    </div>
  );
}

function Cell({
  label,
  value,
  detail,
  emphasis,
}: {
  label: string;
  value: string;
  detail?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
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
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.4rem",
          fontWeight: 700,
          lineHeight: 1,
          color: emphasis ? "var(--accent)" : "var(--text-primary)",
        }}
      >
        {value}
      </span>
      {detail && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-muted)",
          }}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

function RowItem({ row }: { row: SourceRow }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "6px 0",
        borderBottom: "1px dashed var(--border-subtle)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "2px",
          background: SOURCE_COLORS[row.source],
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontSize: "0.78rem",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}
        >
          {row.label}
        </span>
        <span
          style={{
            fontSize: "0.66rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {row.detail}
        </span>
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.85rem",
          color: "var(--text-primary)",
          fontWeight: 600,
        }}
      >
        {formatTokens(row.tokens)}
      </span>
      {row.actionHref && row.actionLabel && (
        <Link
          href={row.actionHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "0.7rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            textDecoration: "none",
            padding: "2px 8px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          {row.actionLabel}
          <ExternalLink style={{ width: "10px", height: "10px" }} />
        </Link>
      )}
    </div>
  );
}

function Footnote({ data }: { data: ContextOverheadBreakdown }) {
  return (
    <p
      style={{
        fontSize: "0.66rem",
        color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
        margin: 0,
        lineHeight: 1.5,
      }}
    >
      Theoretical minimum is {formatTokens(data.theoreticalMinTokens)} tokens
      (system prompt only). &quot;Skills&quot; counts the full body of each
      registered skill — actual passive overhead is lower since Claude Code
      injects only frontmatter descriptors until a skill is invoked.
      &quot;Observed&quot; is the median first-turn{" "}
      <code style={{ fontFamily: "var(--font-mono)" }}>cache_create_tokens</code>{" "}
      across recent sessions.
    </p>
  );
}
