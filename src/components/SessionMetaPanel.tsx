"use client";

import { GitCommit, Upload, FilePen, Plus, Minus, Database } from "lucide-react";
import type { SessionMeta } from "@/lib/scanner/claudeStats";

// Surfaces the rich per-session record Claude Code keeps in
// ~/.claude/usage-data/session-meta/<id>.json — git activity, lines changed,
// tool-error categories, and capability-usage flags. Read-only; rendered only
// when the record exists (see SessionDetailView). cc-lens-inspired (item 2).

const labelStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

function MetaChip({
  icon,
  label,
  value,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  tone?: "pos" | "neg";
}) {
  const color =
    tone === "pos"
      ? "var(--status-active-text)"
      : tone === "neg"
        ? "var(--status-error-text)"
        : "var(--text-secondary)";
  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "3px 9px",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        color,
      }}
    >
      {icon}
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </span>
  );
}

const ic = { width: "11px", height: "11px" } as const;

export function SessionMetaPanel({ meta }: { meta: SessionMeta }) {
  const git: React.ReactNode[] = [];
  if (meta.gitCommits) git.push(<MetaChip key="c" icon={<GitCommit style={ic} />} label="commits" value={meta.gitCommits} />);
  if (meta.gitPushes) git.push(<MetaChip key="p" icon={<Upload style={ic} />} label="pushes" value={meta.gitPushes} />);
  if (meta.linesAdded) git.push(<MetaChip key="la" icon={<Plus style={ic} />} label="added" value={meta.linesAdded} tone="pos" />);
  if (meta.linesRemoved) git.push(<MetaChip key="lr" icon={<Minus style={ic} />} label="removed" value={meta.linesRemoved} tone="neg" />);
  if (meta.filesModified) git.push(<MetaChip key="fm" icon={<FilePen style={ic} />} label="files" value={meta.filesModified} />);
  if (meta.userInterruptions) git.push(<MetaChip key="ui" label="interruptions" value={meta.userInterruptions} />);

  const flags = (
    [
      ["Task agent", meta.usesTaskAgent],
      ["MCP", meta.usesMcp],
      ["Web search", meta.usesWebSearch],
      ["Web fetch", meta.usesWebFetch],
    ] as [string, boolean | undefined][]
  ).filter(([, on]) => on);

  const errorCats = meta.toolErrorCategories
    ? Object.entries(meta.toolErrorCategories).sort((a, b) => b[1] - a[1])
    : [];

  // Nothing worth showing — render nothing rather than an empty card.
  if (git.length === 0 && flags.length === 0 && errorCats.length === 0) return null;

  return (
    <div
      style={{
        padding: "16px 20px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderTop: "none",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Database style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        <span style={labelStyle}>Session metadata</span>
        <span style={{ fontSize: "0.66rem", color: "var(--text-muted)", marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
          from Claude Code
        </span>
      </div>

      {git.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>{git}</div>
      )}

      {flags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "0.66rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>uses</span>
          {flags.map(([name]) => (
            <span
              key={name}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.66rem",
                color: "var(--accent)",
                background: "var(--accent-bg)",
                border: "1px solid var(--accent-border)",
                borderRadius: "3px",
                padding: "2px 7px",
              }}
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {errorCats.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "0.66rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            tool errors
          </span>
          {errorCats.map(([cat, count]) => (
            <span
              key={cat}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "2px 8px",
                background: "var(--status-error-bg)",
                border: "1px solid var(--status-error-border)",
                borderRadius: "var(--radius)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.66rem",
              }}
            >
              <span style={{ color: "var(--status-error-text)", fontWeight: 600 }}>{count}×</span>
              <span style={{ color: "var(--text-secondary)" }}>{cat}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
