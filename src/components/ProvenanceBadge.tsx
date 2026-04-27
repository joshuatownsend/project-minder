"use client";

import { ExternalLink } from "lucide-react";
import type { Provenance } from "@/lib/indexer/types";

interface Props {
  provenance?: Provenance;
  hasUpdate?: boolean;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

function githubRepoFromUrl(sourceUrl: string): string | null {
  const m = sourceUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

export function ProvenanceBadge({ provenance, hasUpdate }: Props) {
  if (!provenance) {
    return (
      <span style={badgeStyle("var(--text-secondary)")}>user</span>
    );
  }

  const p = provenance;

  if (p.kind === "marketplace-plugin") {
    const label = truncateMiddle(p.marketplace || p.pluginName, 28);
    const version = p.pluginVersion ? ` · v${p.pluginVersion}` : "";
    return (
      <span style={badgeStyle("var(--accent)")}>
        {label}{version}
        {hasUpdate && (
          <span
            title="Update available"
            style={{
              display: "inline-block",
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: "var(--warning, #f59e0b)",
              marginLeft: "4px",
              verticalAlign: "middle",
            }}
          />
        )}
      </span>
    );
  }

  if (p.kind === "lockfile") {
    const repo = githubRepoFromUrl(p.sourceUrl);
    const label = repo ? truncateMiddle(repo, 28) : truncateMiddle(p.source, 28);
    return (
      <span style={badgeStyle("var(--accent)")}>
        {label}
        {hasUpdate && (
          <span
            title="Update available"
            style={{
              display: "inline-block",
              width: "5px",
              height: "5px",
              borderRadius: "50%",
              background: "var(--warning, #f59e0b)",
              marginLeft: "4px",
              verticalAlign: "middle",
            }}
          />
        )}
      </span>
    );
  }

  if (p.kind === "project-local") {
    return (
      <span style={badgeStyle("var(--success, #4ade80)")}>
        project: {p.projectSlug}
      </span>
    );
  }

  return <span style={badgeStyle("var(--text-secondary)")}>local</span>;
}

// Expanded provenance block shown inside the row when expanded
export function ProvenanceDetails({ provenance }: { provenance?: Provenance }) {
  if (!provenance || provenance.kind === "user-local") {
    return (
      <div style={detailsStyle}>
        <span style={labelStyle}>origin</span>
        <span style={valueStyle}>local file</span>
      </div>
    );
  }

  const p = provenance;

  if (p.kind === "marketplace-plugin") {
    const repoUrl = p.pluginRepoUrl
      ? ensureHttps(p.pluginRepoUrl)
      : p.marketplaceRepo
      ? `https://github.com/${p.marketplaceRepo}`
      : null;

    return (
      <div style={detailsStyle}>
        <Row label="marketplace" value={p.marketplace} />
        {p.marketplaceRepo && <Row label="repo" value={p.marketplaceRepo} />}
        {p.pluginVersion && p.pluginVersion !== "unknown" && (
          <Row label="version" value={`v${p.pluginVersion}`} />
        )}
        {p.gitCommitSha && (
          <Row label="commit" value={p.gitCommitSha.slice(0, 7)} mono />
        )}
        {p.installedAt && (
          <Row label="installed" value={relativeDate(p.installedAt)} />
        )}
        {p.lastUpdated && (
          <Row label="updated" value={relativeDate(p.lastUpdated)} />
        )}
        {repoUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "1px" }}>
            <span style={labelStyle}>source</span>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                fontSize: "0.6rem",
                fontFamily: "var(--font-mono)",
                color: "var(--accent)",
                textDecoration: "none",
              }}
            >
              {p.marketplaceRepo ?? repoUrl}
              <ExternalLink style={{ width: "9px", height: "9px" }} />
            </a>
          </div>
        )}
      </div>
    );
  }

  if (p.kind === "lockfile") {
    const repo = githubRepoFromUrl(p.sourceUrl);
    const repoUrl = repo ? `https://github.com/${repo}` : null;

    return (
      <div style={detailsStyle}>
        <Row label="source" value={p.source} />
        <Row label="type" value={p.sourceType} />
        {p.skillFolderHash && (
          <Row label="hash" value={p.skillFolderHash.slice(0, 7)} mono />
        )}
        {p.installedAt && (
          <Row label="installed" value={relativeDate(p.installedAt)} />
        )}
        {p.updatedAt && (
          <Row label="updated" value={relativeDate(p.updatedAt)} />
        )}
        {repoUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "1px" }}>
            <span style={labelStyle}>repo</span>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                fontSize: "0.6rem",
                fontFamily: "var(--font-mono)",
                color: "var(--accent)",
                textDecoration: "none",
              }}
            >
              {repo}
              <ExternalLink style={{ width: "9px", height: "9px" }} />
            </a>
          </div>
        )}
      </div>
    );
  }

  if (p.kind === "project-local") {
    return (
      <div style={detailsStyle}>
        <Row label="origin" value="project-local" />
        <Row label="project" value={p.projectSlug} />
      </div>
    );
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontFamily: "var(--font-mono)",
    fontSize: "0.6rem",
    color,
    background: "var(--bg-surface)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "3px",
    padding: "1px 5px",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
  };
}

const detailsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  padding: "6px 8px",
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.58rem",
  fontFamily: "var(--font-mono)",
  color: "var(--text-muted)",
  minWidth: "60px",
  display: "inline-block",
};

const valueStyle: React.CSSProperties = {
  fontSize: "0.6rem",
  fontFamily: "var(--font-mono)",
  color: "var(--text-secondary)",
};

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <span style={labelStyle}>{label}</span>
      <span style={{ ...valueStyle, fontFamily: mono ? "var(--font-mono)" : "var(--font-body)" }}>
        {value}
      </span>
    </div>
  );
}

function ensureHttps(url: string): string {
  if (url.startsWith("http")) return url;
  return `https://${url}`;
}

function relativeDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return iso;
    const diffMs = Date.now() - d.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays < 1) return "today";
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
  } catch {
    return iso;
  }
}
