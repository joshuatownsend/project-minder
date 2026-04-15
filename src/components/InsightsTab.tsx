"use client";

import { useState } from "react";
import { useProjectInsights } from "@/hooks/useInsights";
import { Search, Lightbulb, ExternalLink } from "lucide-react";
import Link from "next/link";
import { WorktreeOverlay } from "@/lib/types";
import { WorktreeSection } from "./WorktreeSection";

interface InsightsTabProps {
  slug: string;
  worktrees?: WorktreeOverlay[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function InsightsTab({ slug, worktrees }: InsightsTabProps) {
  const { data, loading } = useProjectInsights(slug);
  const [query, setQuery] = useState("");

  const filtered =
    data?.entries.filter((e) =>
      e.content.toLowerCase().includes(query.toLowerCase())
    ) ?? [];

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            style={{
              height: "64px",
              background: "var(--bg-surface)",
              borderRadius: "var(--radius)",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Search */}
      <div style={{ position: "relative" }}>
        <Search
          style={{
            position: "absolute",
            left: "9px",
            top: "50%",
            transform: "translateY(-50%)",
            width: "13px",
            height: "13px",
            color: "var(--text-muted)",
            pointerEvents: "none",
          }}
        />
        <input
          type="text"
          placeholder="Filter insights…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            height: "32px",
            paddingLeft: "30px",
            paddingRight: "10px",
            fontSize: "0.78rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {/* Count */}
      {data && data.total > 0 && (
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            marginTop: "-6px",
          }}
        >
          {filtered.length === data.total
            ? `${data.total} insight${data.total !== 1 ? "s" : ""}`
            : `${filtered.length} of ${data.total} insights`}
        </div>
      )}

      {/* Feed */}
      {filtered.length === 0 ? (
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
          <Lightbulb
            style={{ width: "24px", height: "24px", color: "var(--text-muted)", opacity: 0.3 }}
          />
          <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            {query
              ? "No insights match your filter."
              : "No insights recorded for this project yet."}
          </p>
        </div>
      ) : (
        <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
          {filtered.map((insight) => (
            <div
              key={insight.id}
              style={{
                padding: "12px 0",
                borderBottom: "1px solid var(--border-subtle)",
                display: "flex",
                flexDirection: "column",
                gap: "5px",
              }}
            >
              {/* Metadata row */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.65rem",
                    color: "var(--text-muted)",
                  }}
                >
                  {formatDate(insight.date)}
                </span>
                <div style={{ flex: 1 }} />
                <Link
                  href={`/sessions/${insight.sessionId}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.65rem",
                    color: "var(--text-muted)",
                    textDecoration: "none",
                    transition: "color 0.1s",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLElement).style.color =
                      "var(--text-secondary)")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLElement).style.color =
                      "var(--text-muted)")
                  }
                >
                  session
                  <ExternalLink style={{ width: "9px", height: "9px" }} />
                </Link>
              </div>
              {/* Content */}
              <p
                style={{
                  fontSize: "0.82rem",
                  lineHeight: 1.6,
                  color: "var(--text-primary)",
                  margin: 0,
                  whiteSpace: "pre-wrap",
                }}
              >
                {insight.content}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Worktree sections */}
      {worktrees?.map((wt) =>
        wt.insights && wt.insights.total > 0 ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.insights.total}
            itemLabel={wt.insights.total === 1 ? "insight" : "insights"}
          >
            <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
              {wt.insights.entries
                .filter((e) =>
                  e.content.toLowerCase().includes(query.toLowerCase())
                )
                .map((insight) => (
                  <div
                    key={insight.id}
                    style={{
                      padding: "12px 0",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "5px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.65rem",
                        color: "var(--text-muted)",
                      }}
                    >
                      {formatDate(insight.date)}
                    </span>
                    <p
                      style={{
                        fontSize: "0.82rem",
                        lineHeight: 1.6,
                        color: "var(--text-primary)",
                        margin: 0,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {insight.content}
                    </p>
                  </div>
                ))}
            </div>
          </WorktreeSection>
        ) : null
      )}
    </div>
  );
}
