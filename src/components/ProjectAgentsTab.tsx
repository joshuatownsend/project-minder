"use client";

import { Bot, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useAgents, type AgentRow } from "@/hooks/useAgents";
import { ProvenanceBadge } from "@/components/ProvenanceBadge";

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays < 1) return "today";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function CompactRow({ row, projectSlug }: { row: AgentRow; projectSlug: string }) {
  const name = row.entry?.name ?? row.usage?.name ?? "Unknown";
  const invocations = row.usage?.projects[projectSlug] ?? row.usage?.invocations ?? 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <span
        style={{
          fontSize: "0.78rem",
          fontWeight: 500,
          color: "var(--text-primary)",
          fontFamily: "var(--font-body)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <ProvenanceBadge provenance={row.entry?.provenance} />
      {row.entry?.model && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
          }}
        >
          {row.entry.model}
        </span>
      )}
      {invocations > 0 && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            fontWeight: 600,
            color: "var(--accent)",
          }}
        >
          {invocations}×
        </span>
      )}
      {row.usage?.lastUsed && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          {formatDate(row.usage.lastUsed)}
        </span>
      )}
      {row.usage?.sessions && row.usage.sessions[0] && (
        <Link
          href={`/sessions/${row.usage.sessions[0]}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--text-muted)",
            textDecoration: "none",
          }}
          title="Latest session"
        >
          <ExternalLink style={{ width: "10px", height: "10px" }} />
        </Link>
      )}
    </div>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        fontSize: "0.6rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        fontFamily: "var(--font-body)",
        marginBottom: "4px",
        marginTop: "16px",
      }}
    >
      {label}
      <span style={{ marginLeft: "6px", fontWeight: 400 }}>({count})</span>
    </div>
  );
}

interface Props {
  slug: string;
}

export function ProjectAgentsTab({ slug }: Props) {
  const { data, loading } = useAgents(undefined, slug);

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            style={{
              height: "32px",
              background: "var(--bg-surface)",
              borderRadius: "var(--radius)",
              opacity: 0.5,
            }}
          />
        ))}
      </div>
    );
  }

  const available = data.filter(
    (r) => r.entry?.source === "project" && r.entry.projectSlug === slug
  );
  const invoked = data
    .filter((r) => (r.usage?.projects[slug] ?? 0) > 0)
    .sort((a, b) => (b.usage?.projects[slug] ?? 0) - (a.usage?.projects[slug] ?? 0));

  const totalInvocations = invoked.reduce(
    (sum, r) => sum + (r.usage?.projects[slug] ?? 0),
    0
  );

  if (available.length === 0 && invoked.length === 0) {
    return (
      <div
        style={{
          padding: "32px 0",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <Bot style={{ width: "24px", height: "24px", color: "var(--text-muted)", opacity: 0.3 }} />
        <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
          No agents defined or invoked in this project.
        </p>
      </div>
    );
  }

  return (
    <div>
      {available.length > 0 && (
        <>
          <SectionLabel label="Available (project-local)" count={available.length} />
          {available.map((row, i) => (
            <CompactRow
              key={row.entry?.id ?? i}
              row={row}
              projectSlug={slug}
            />
          ))}
        </>
      )}

      {invoked.length > 0 && (
        <>
          <SectionLabel
            label={`Invoked here · ${totalInvocations} total`}
            count={invoked.length}
          />
          {invoked.map((row, i) => (
            <CompactRow
              key={row.entry?.id ?? row.usage?.name ?? i}
              row={row}
              projectSlug={slug}
            />
          ))}
        </>
      )}
    </div>
  );
}
