"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { ProjectData, ProjectStatus } from "@/lib/types";
import { ProjectCard } from "./ProjectCard";
import { ManageHiddenProjects } from "./ManageHiddenProjects";
import { Skeleton } from "./ui/skeleton";
import { QuickAddTodosModal } from "./QuickAddTodosModal";
import { Search, RefreshCw, Plus } from "lucide-react";

type SortOption = "activity" | "name" | "claude";

interface DirtyStatusOverride {
  isDirty: boolean;
  uncommittedCount: number;
}

interface DashboardGridProps {
  projects: ProjectData[];
  hiddenCount: number;
  loading: boolean;
  onRescan: () => void;
  onHide: (slug: string, dirName: string) => void;
  gitDirtyOverrides?: Record<string, DirtyStatusOverride>;
}

export function DashboardGrid({
  projects,
  hiddenCount,
  loading,
  onRescan,
  onHide,
  gitDirtyOverrides,
}: DashboardGridProps) {
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all");
  const [sortBy, setSortBy]           = useState<SortOption>("activity");
  const [showHidden, setShowHidden]   = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const filtered = useMemo(() => {
    let result = gitDirtyOverrides
      ? projects.map((p) => {
          const override = gitDirtyOverrides[p.slug];
          if (override && p.git) {
            return { ...p, git: { ...p.git, ...override } };
          }
          return p;
        })
      : projects;

    // Archived projects are hidden in the default "all" view
    if (statusFilter === "all") {
      result = result.filter((p) => p.status !== "archived");
    } else {
      result = result.filter((p) => p.status === statusFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.framework?.toLowerCase().includes(q) ||
          p.orm?.toLowerCase().includes(q) ||
          p.slug.includes(q)
      );
    }

    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "claude": {
          const ta = a.claude?.lastSessionDate ? new Date(a.claude.lastSessionDate).getTime() : 0;
          const tb = b.claude?.lastSessionDate ? new Date(b.claude.lastSessionDate).getTime() : 0;
          return tb - ta;
        }
        case "activity":
        default: {
          const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
          const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
          return tb - ta;
        }
      }
    });

    return result;
  }, [projects, search, statusFilter, sortBy, gitDirtyOverrides]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const active = document.activeElement;
    const inField = active?.tagName === "INPUT" || active?.tagName === "TEXTAREA";

    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !inField) {
      e.preventDefault();
      document.getElementById("search-input")?.focus();
    }
    if (e.key === "T" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !inField) {
      e.preventDefault();
      setQuickAddOpen(true);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const statusOptions: { value: ProjectStatus | "all"; label: string }[] = [
    { value: "all",      label: "All"      },
    { value: "active",   label: "Active"   },
    { value: "paused",   label: "Paused"   },
    { value: "archived", label: "Archived" },
  ];

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "activity", label: "Recent"  },
    { value: "claude",   label: "Claude"  },
    { value: "name",     label: "A–Z"     },
  ];

  const archivedCount = projects.filter((p) => p.status === "archived").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
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
            id="search-input"
            type="text"
            placeholder="Search… (/)"
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

        {/* Divider */}
        <div style={{ width: "1px", height: "20px", background: "var(--border-subtle)", flexShrink: 0 }} />

        {/* Status filters */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem",
                fontWeight: statusFilter === opt.value ? 600 : 400,
                fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color: statusFilter === opt.value
                  ? "var(--text-primary)"
                  : "var(--text-secondary)",
                background: statusFilter === opt.value
                  ? "var(--bg-elevated)"
                  : "transparent",
                border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
                lineHeight: 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              style={{
                padding: "5px 11px",
                fontSize: "0.72rem",
                fontWeight: sortBy === opt.value ? 600 : 400,
                fontFamily: "var(--font-body)",
                letterSpacing: "0.03em",
                color: sortBy === opt.value
                  ? "var(--text-primary)"
                  : "var(--text-secondary)",
                background: sortBy === opt.value
                  ? "var(--bg-elevated)"
                  : "transparent",
                border: "none",
                borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
                lineHeight: 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Quick Add */}
        <button
          onClick={() => setQuickAddOpen(true)}
          title="Quick Add TODOs (Shift+T)"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "5px 11px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-body)",
            letterSpacing: "0.03em",
            color: "var(--text-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            cursor: "pointer",
            transition: "color 0.1s, border-color 0.1s",
            flexShrink: 0,
          }}
        >
          <Plus style={{ width: "11px", height: "11px" }} />
          Quick Add
        </button>

        {/* Rescan */}
        <button
          onClick={onRescan}
          disabled={loading}
          title="Rescan projects"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "5px 11px",
            fontSize: "0.72rem",
            fontFamily: "var(--font-body)",
            letterSpacing: "0.03em",
            color: "var(--text-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.5 : 1,
            transition: "color 0.1s, border-color 0.1s",
            flexShrink: 0,
          }}
        >
          <RefreshCw
            style={{
              width: "11px",
              height: "11px",
              animation: loading ? "spin 1s linear infinite" : "none",
            }}
          />
          Rescan
        </button>
      </div>

      {/* ── Meta row: count + hidden ──────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          marginTop: "-8px",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {filtered.length} project{filtered.length !== 1 ? "s" : ""}
        </span>
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowHidden(true)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
              textUnderlineOffset: "2px",
            }}
          >
            {hiddenCount} hidden
          </button>
        )}
        {statusFilter === "all" && archivedCount > 0 && (
          <button
            onClick={() => setStatusFilter("archived")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: "0.72rem",
              fontFamily: "var(--font-body)",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
              textUnderlineOffset: "2px",
            }}
          >
            {archivedCount} archived
          </button>
        )}
      </div>

      {/* ── Grid ─────────────────────────────────────────────────────────── */}
      {loading && projects.length === 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "14px",
          }}
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded" />
          ))}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "14px",
          }}
        >
          {filtered.map((project) => (
            <ProjectCard key={project.slug} project={project} onHide={onHide} />
          ))}
          {filtered.length === 0 && (
            <p
              style={{
                gridColumn: "1 / -1",
                textAlign: "center",
                color: "var(--text-muted)",
                padding: "48px 0",
                fontSize: "0.8rem",
              }}
            >
              No projects match.
            </p>
          )}
        </div>
      )}

      <QuickAddTodosModal
        projects={projects}
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />

      {showHidden && (
        <ManageHiddenProjects
          onClose={() => setShowHidden(false)}
          onUnhide={() => {
            setShowHidden(false);
            onRescan();
          }}
        />
      )}
    </div>
  );
}
