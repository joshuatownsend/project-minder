"use client";

import { useEffect, useState } from "react";
import { GitCommit, GitBranch, UploadCloud } from "lucide-react";
import type { GitActivitySummary } from "@/lib/usage/gitActivity";

interface GitActivityResponse {
  slug: string;
  activity: GitActivitySummary;
}

function StatBox({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: "10px 14px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "5px" }}>
        {icon}
        <span
          style={{
            fontSize: "0.62rem",
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontFamily: "var(--font-body)",
          }}
        >
          {label}
        </span>
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.3rem",
          fontWeight: 600,
          color: "var(--text-primary)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function GitActivityPanel({ slug }: { slug: string }) {
  const [data, setData] = useState<GitActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/projects/${slug}/git-activity`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GitActivityResponse | null) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div
        style={{
          height: "80px",
          background: "var(--bg-surface)",
          borderRadius: "var(--radius)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
    );
  }
  if (!data) return null;
  const { commits, pushes, branches } = data.activity;
  if (commits === 0 && pushes === 0 && branches.length === 0) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "10px",
        }}
      >
        <GitBranch style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        <span
          style={{
            fontSize: "0.68rem",
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontFamily: "var(--font-body)",
          }}
        >
          Git Activity
        </span>
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: branches.length > 0 ? "12px" : "0" }}>
        <StatBox
          label="Commits"
          value={commits}
          icon={<GitCommit style={{ width: "11px", height: "11px", color: "var(--text-muted)" }} />}
        />
        <StatBox
          label="Pushes"
          value={pushes}
          icon={<UploadCloud style={{ width: "11px", height: "11px", color: "var(--text-muted)" }} />}
        />
      </div>

      {branches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {branches.map((b) => (
            <div
              key={b.branch}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "5px 0",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <GitBranch
                style={{ width: "10px", height: "10px", color: "var(--text-muted)", flexShrink: 0 }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.75rem",
                  color: "var(--text-primary)",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {b.branch}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                {b.sessionCount} session{b.sessionCount !== 1 ? "s" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
