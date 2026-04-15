"use client";

import { useState, useMemo, useEffect } from "react";
import { useAllInsights } from "@/hooks/useInsights";
import { InsightEntry } from "@/lib/types";
import { Lightbulb, Search, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// ── Single insight row with expand/collapse ───────────────────────────────────
function InsightRow({ insight }: { insight: InsightEntry }) {
  const [expanded, setExpanded] = useState(false);
  const lines = insight.content.split("\n").filter(Boolean);
  const isLong = lines.length > 2 || insight.content.length > 180;

  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* Metadata row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: "5px",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
            flexShrink: 0,
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
            flexShrink: 0,
            transition: "color 0.1s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color = "var(--text-secondary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color = "var(--text-muted)")
          }
        >
          session
          <ExternalLink style={{ width: "9px", height: "9px" }} />
        </Link>
      </div>

      {/* Content — truncated unless expanded */}
      <p
        style={{
          fontSize: "0.8rem",
          lineHeight: 1.6,
          color: "var(--text-primary)",
          margin: 0,
          whiteSpace: "pre-wrap",
          ...(isLong && !expanded
            ? {
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
            : {}),
        }}
      >
        {insight.content}
      </p>

      {/* Expand toggle */}
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: "4px",
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            background: "none",
            border: "none",
            padding: 0,
            fontSize: "0.68rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-muted)",
            cursor: "pointer",
            transition: "color 0.1s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.color = "var(--text-secondary)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.color = "var(--text-muted)")
          }
        >
          {expanded ? "less" : "more"}
        </button>
      )}
    </div>
  );
}

// ── Per-project section ───────────────────────────────────────────────────────
function ProjectSection({
  projectSlug,
  insights,
  collapsed,
  onToggle,
}: {
  projectSlug: string;
  insights: InsightEntry[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      {/* Section header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          paddingBottom: "10px",
          marginBottom: collapsed ? 0 : "2px",
        }}
      >
        <button
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "16px",
            height: "16px",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {collapsed ? (
            <ChevronRight style={{ width: "12px", height: "12px" }} />
          ) : (
            <ChevronDown style={{ width: "12px", height: "12px" }} />
          )}
        </button>

        <Link
          href={`/project/${projectSlug}`}
          style={{
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "var(--text-primary)",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            textDecoration: "none",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {projectSlug}
        </Link>

        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
          }}
        >
          {insights.length}
        </span>

        {/* Rule */}
        <div
          style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }}
        />
      </div>

      {/* Insights feed */}
      {!collapsed && (
        <div style={{ paddingLeft: "26px", borderTop: "1px solid var(--border-subtle)" }}>
          {insights.map((insight) => (
            <InsightRow key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main browser ──────────────────────────────────────────────────────────────
export function InsightsBrowser() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [collapsedSlugs, setCollapsedSlugs] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, loading } = useAllInsights(
    projectFilter || undefined,
    debouncedSearch || undefined
  );

  // Group insights by project
  const grouped = useMemo(() => {
    const map = new Map<string, InsightEntry[]>();
    for (const insight of data.insights) {
      const list = map.get(insight.project) ?? [];
      list.push(insight);
      map.set(insight.project, list);
    }
    // Preserve API order (already sorted by recency) — just group
    return Array.from(map.entries());
  }, [data.insights]);

  const projects = useMemo(
    () => grouped.map(([slug]) => slug).sort(),
    [grouped]
  );

  const toggleCollapse = (slug: string) => {
    setCollapsedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const allCollapsed =
    grouped.length > 0 && grouped.every(([slug]) => collapsedSlugs.has(slug));
  const collapseAll = () =>
    setCollapsedSlugs(new Set(grouped.map(([slug]) => slug)));
  const expandAll = () => setCollapsedSlugs(new Set());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <Lightbulb
          style={{ width: "14px", height: "14px", color: "var(--text-muted)" }}
        />
        <h1
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
          }}
        >
          Insights
        </h1>
        {data.total > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--text-muted)",
            }}
          >
            {data.total} total
          </span>
        )}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {/* Search */}
        <div
          style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}
        >
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
            placeholder="Search insights…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
            }}
          />
        </div>

        {/* Project filter */}
        {!projectFilter && grouped.length > 1 && (
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            style={{
              height: "32px",
              padding: "0 10px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              outline: "none",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        {/* Active project filter chip */}
        {projectFilter && (
          <button
            onClick={() => setProjectFilter("")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              height: "32px",
              padding: "0 10px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {projectFilter}
            <span style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>×</span>
          </button>
        )}

        {/* Collapse/expand all — only when multiple groups visible */}
        {grouped.length > 1 && (
          <button
            onClick={allCollapsed ? expandAll : collapseAll}
            style={{
              padding: "5px 11px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              letterSpacing: "0.03em",
              color: "var(--text-secondary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              transition: "color 0.1s",
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {/* ── Meta row ─────────────────────────────────────────────────────────── */}
      {!loading && (
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            marginTop: "-8px",
          }}
        >
          {data.insights.length} insight{data.insights.length !== 1 ? "s" : ""}
          {(search || projectFilter) && data.insights.length !== data.total
            ? ` of ${data.total}`
            : ""}
          {grouped.length > 1 ? `, ${grouped.length} projects` : ""}
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                height: "72px",
                background: "var(--bg-surface)",
                borderRadius: "var(--radius)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 0",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <Lightbulb
            style={{
              width: "28px",
              height: "28px",
              color: "var(--text-muted)",
              opacity: 0.4,
            }}
          />
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            No insights found.
          </p>
          {(search || projectFilter) && (
            <p
              style={{
                fontSize: "0.72rem",
                color: "var(--text-muted)",
                opacity: 0.6,
              }}
            >
              Try a different search term or project filter.
            </p>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {grouped.map(([projectSlug, insights]) => (
            <ProjectSection
              key={projectSlug}
              projectSlug={projectSlug}
              insights={insights}
              collapsed={collapsedSlugs.has(projectSlug)}
              onToggle={() => toggleCollapse(projectSlug)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
