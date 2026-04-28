"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { ProjectData, ProjectStatus } from "@/lib/types";
import { useLiveSessionStatus } from "@/hooks/useLiveSessionStatus";
import { ProjectCard } from "./ProjectCard";
import { SparklineList } from "./SparklineList";
import { Skeleton } from "./ui/skeleton";
import { QuickAddTodosModal } from "./QuickAddTodosModal";
import { useToast } from "./ToastProvider";
import Link from "next/link";
import {
  Search, RefreshCw, Plus, LayoutGrid, Rows3, LayoutDashboard,
  CircleHelp, ChevronDown, ChevronRight, RotateCcw,
  Layers, CircleDot, CirclePause, Archive, Clock, Bot, ArrowUpAZ,
} from "lucide-react";
import { useHelp } from "./HelpProvider";
import { usePathname } from "next/navigation";
import { formatRelativeTime } from "@/lib/utils";

type SortOption = "activity" | "name" | "claude";
type ViewMode = "full" | "compact" | "list";

interface DirtyStatusOverride {
  isDirty: boolean;
  uncommittedCount: number;
}

interface DashboardGridProps {
  projects: ProjectData[];
  loading: boolean;
  onRescan: () => void;
  onArchive: (slug: string) => void;
  onUnarchive: (slug: string) => void;
  scannedAt?: string;
  gitDirtyOverrides?: Record<string, DirtyStatusOverride>;
}

const NEXT_VIEW: Record<ViewMode, ViewMode> = { full: "compact", compact: "list", list: "full" };

const statusOptions = [
  { value: "all" as const,      label: "All",      icon: <Layers      style={{ width: "11px", height: "11px" }} /> },
  { value: "active" as const,   label: "Active",   icon: <CircleDot   style={{ width: "11px", height: "11px" }} /> },
  { value: "paused" as const,   label: "Paused",   icon: <CirclePause style={{ width: "11px", height: "11px" }} /> },
  { value: "archived" as const, label: "Archived", icon: <Archive     style={{ width: "11px", height: "11px" }} /> },
];

const sortOptions = [
  { value: "activity" as const, label: "Recent",       title: "Sort by most recent file activity",  icon: <Clock     style={{ width: "11px", height: "11px" }} /> },
  { value: "claude" as const,   label: "Last Session", title: "Sort by most recent Claude session", icon: <Bot       style={{ width: "11px", height: "11px" }} /> },
  { value: "name" as const,     label: "A–Z",          title: "Sort alphabetically",                icon: <ArrowUpAZ style={{ width: "11px", height: "11px" }} /> },
];

const viewOptions = [
  { value: "full" as const,    icon: <LayoutGrid      style={{ width: "11px", height: "11px" }} />, title: "Full cards",     label: "Full"    },
  { value: "compact" as const, icon: <LayoutDashboard style={{ width: "11px", height: "11px" }} />, title: "Compact cards",  label: "Compact" },
  { value: "list" as const,    icon: <Rows3           style={{ width: "11px", height: "11px" }} />, title: "Sparkline list", label: "List"    },
];

export function DashboardGrid({
  projects,
  loading,
  onRescan,
  onArchive,
  onUnarchive,
  scannedAt,
  gitDirtyOverrides,
}: DashboardGridProps) {
  const [search, setSearch]               = useState("");
  const [statusFilter, setStatusFilter]   = useState<ProjectStatus | "all">("all");
  const [sortBy, setSortBy]               = useState<SortOption>("claude");
  const [viewMode, setViewMode]           = useState<ViewMode>("full");
  const [quickAddOpen, setQuickAddOpen]   = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [activityData, setActivityData]   = useState<Record<string, number[]>>({});
  const [activityError, setActivityError] = useState(false);
  const [pinnedSlugs, setPinnedSlugs]     = useState<string[]>([]);
  const activityFetched = useRef(false);
  const { openHelpForRoute } = useHelp();
  const pathname = usePathname();
  const liveStatus = useLiveSessionStatus();
  const { showToast } = useToast();

  // Apply dashboard defaults from config on first mount
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.defaultSort)         setSortBy(cfg.defaultSort as SortOption);
        if (cfg.defaultStatusFilter) setStatusFilter(cfg.defaultStatusFilter as ProjectStatus | "all");
        if (cfg.viewMode)            setViewMode(cfg.viewMode as ViewMode);
        if (Array.isArray(cfg.pinnedSlugs)) setPinnedSlugs(cfg.pinnedSlugs);
      })
      .catch(() => {});
  }, []);

  // Fetch sparkline data when entering list mode
  useEffect(() => {
    if (viewMode !== "list") return;
    if (activityFetched.current && Object.keys(activityData).length > 0) return;
    activityFetched.current = true;
    setActivityError(false);
    fetch("/api/sessions/activity")
      .then((r) => r.json())
      .then((data) => { setActivityData(data); setActivityError(false); })
      .catch(() => setActivityError(true));
  }, [viewMode]);

  const onTogglePin = useCallback((slug: string) => {
    setPinnedSlugs((prev) => {
      const added = !prev.includes(slug);
      const next = added ? [...prev, slug] : prev.filter((s) => s !== slug);
      fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedSlugs: next }),
      }).catch(() => setPinnedSlugs((cur) =>
        added ? cur.filter((s) => s !== slug) : cur.includes(slug) ? cur : [...cur, slug]
      ));
      return next;
    });
  }, []);

  const persistViewMode = useCallback((mode: ViewMode) => {
    fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewMode: mode }),
    }).catch(() => {});
  }, []);

  const cycleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next = NEXT_VIEW[prev];
      persistViewMode(next);
      return next;
    });
  }, [persistViewMode]);

  const setViewAndPersist = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    persistViewMode(mode);
  }, [persistViewMode]);

  const handleArchive = useCallback((slug: string) => {
    const project = projects.find((p) => p.slug === slug);
    const name = project?.name ?? slug;
    onArchive(slug);
    showToast(`Archived "${name}".`, undefined, {
      label: "Undo",
      onClick: () => onUnarchive(slug),
    });
  }, [projects, onArchive, onUnarchive, showToast]);

  const filtered = useMemo(() => {
    let result = gitDirtyOverrides
      ? projects.map((p) => {
          const override = gitDirtyOverrides[p.slug];
          if (override && p.git) return { ...p, git: { ...p.git, ...override } };
          return p;
        })
      : projects;

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

    // Stable pin pass: pinned projects float to top, order within each group preserved
    const pinnedSet = new Set(pinnedSlugs);
    result.sort((a, b) => Number(pinnedSet.has(b.slug)) - Number(pinnedSet.has(a.slug)));

    return result;
  }, [projects, search, statusFilter, sortBy, gitDirtyOverrides, pinnedSlugs]);

  const archivedProjects = useMemo(
    () => projects.filter((p) => p.status === "archived"),
    [projects]
  );

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
    if (e.key === "v" && !e.ctrlKey && !e.metaKey && !e.altKey && !inField) {
      e.preventDefault();
      cycleViewMode();
    }
    if (e.key === "r" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !inField) {
      e.preventDefault();
      onRescan();
    }
  }, [cycleViewMode, onRescan]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const overlaidProjects = useMemo(() => filtered.map((project) => {
    const liveKey = project.path.replace(/[:\\/]/g, "-");
    const live = liveStatus.get(liveKey);
    return live && project.claude
      ? { ...project, claude: { ...project.claude, mostRecentSessionStatus: live.status, mostRecentSessionId: live.sessionId } }
      : project;
  }), [filtered, liveStatus]);

  const showArchivedSection = statusFilter === "all" && archivedProjects.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: "160px" }}>
          <label htmlFor="search-input" className="sr-only">Search projects</label>
          <Search
            style={{
              position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)",
              width: "13px", height: "13px", color: "var(--text-muted)", pointerEvents: "none",
            }}
          />
          <input
            id="search-input"
            type="text"
            placeholder="Search… (/)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%", height: "32px", paddingLeft: "30px", paddingRight: "10px",
              fontSize: "0.78rem", fontFamily: "var(--font-body)",
              color: "var(--text-primary)", background: "var(--bg-surface)",
              border: "1px solid var(--border-default)", borderRadius: "var(--radius)", outline: "none",
            }}
          />
        </div>

        {/* Divider */}
        <div style={{ width: "1px", height: "20px", background: "var(--border-subtle)", flexShrink: 0 }} />

        {/* Status filters */}
        <div
          style={{
            display: "flex", alignItems: "center",
            background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
          }}
        >
          {statusOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatusFilter(opt.value)}
              title={opt.label}
              className="toolbar-btn"
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: "2px", padding: "5px 10px", minHeight: "32px",
                color: statusFilter === opt.value ? "var(--text-primary)" : "var(--text-muted)",
                background: statusFilter === opt.value ? "var(--bg-elevated)" : "transparent",
                border: "none", borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer", transition: "background 0.1s, color 0.1s", lineHeight: 1,
              }}
            >
              {opt.icon}
              <span style={{ fontSize: "0.52rem", fontFamily: "var(--font-mono)", letterSpacing: "0.04em", lineHeight: 1 }}>
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        {/* Sort */}
        <div
          style={{
            display: "flex", alignItems: "center",
            background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
          }}
        >
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortBy(opt.value)}
              title={opt.title}
              className="toolbar-btn"
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: "2px", padding: "5px 10px", minHeight: "32px",
                color: sortBy === opt.value ? "var(--text-primary)" : "var(--text-muted)",
                background: sortBy === opt.value ? "var(--bg-elevated)" : "transparent",
                border: "none", borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer", transition: "background 0.1s, color 0.1s", lineHeight: 1,
              }}
            >
              {opt.icon}
              <span style={{ fontSize: "0.52rem", fontFamily: "var(--font-mono)", letterSpacing: "0.04em", lineHeight: 1 }}>
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        {/* View mode toggle */}
        <div
          style={{
            display: "flex", alignItems: "center",
            background: "var(--bg-surface)", border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)", overflow: "hidden", flexShrink: 0,
          }}
          title="Toggle view (v)"
        >
          {viewOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setViewAndPersist(opt.value)}
              title={opt.title}
              aria-label={opt.title}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: "2px", padding: "5px 10px",
                color: viewMode === opt.value ? "var(--info)" : "var(--text-muted)",
                background: viewMode === opt.value ? "var(--info-bg)" : "transparent",
                border: "none", borderRight: "1px solid var(--border-subtle)",
                cursor: "pointer", transition: "background 0.1s, color 0.1s", lineHeight: 1,
              }}
            >
              {opt.icon}
              <span style={{ fontSize: "0.52rem", fontFamily: "var(--font-mono)", letterSpacing: "0.04em", lineHeight: 1 }}>
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: "8px" }} />

        {/* Quick Add */}
        <button
          onClick={() => setQuickAddOpen(true)}
          title="Quick Add TODOs (Shift+T)"
          className="toolbar-btn"
          style={{
            display: "flex", alignItems: "center", gap: "5px",
            padding: "5px 11px", fontSize: "0.72rem", minHeight: "32px",
            fontFamily: "var(--font-body)", letterSpacing: "0.03em",
            color: "var(--text-secondary)", background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
            cursor: "pointer", transition: "color 0.1s, border-color 0.1s", flexShrink: 0,
          }}
        >
          <Plus style={{ width: "11px", height: "11px" }} />
          Quick Add
        </button>

        {/* Rescan */}
        <button
          onClick={onRescan}
          disabled={loading}
          title="Rescan projects (r)"
          className="toolbar-btn"
          style={{
            display: "flex", alignItems: "center", gap: "5px",
            padding: "5px 11px", fontSize: "0.72rem", minHeight: "32px",
            fontFamily: "var(--font-body)", letterSpacing: "0.03em",
            color: "var(--text-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.5 : 1,
            transition: "color 0.1s, border-color 0.1s", flexShrink: 0,
          }}
        >
          <RefreshCw style={{ width: "11px", height: "11px", animation: loading ? "spin 1s linear infinite" : "none" }} />
          Rescan
        </button>

        {/* Help */}
        <button
          onClick={() => openHelpForRoute(pathname)}
          title="Help & shortcuts (?)"
          aria-label="Open help panel"
          className="toolbar-btn"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "32px", height: "32px", padding: 0,
            color: "var(--text-muted)", background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
            cursor: "pointer", transition: "color 0.1s, border-color 0.1s", flexShrink: 0,
          }}
        >
          <CircleHelp style={{ width: "13px", height: "13px" }} />
        </button>
      </div>

      {/* ── Meta row ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: "12px",
          fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "-8px",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {filtered.length} project{filtered.length !== 1 ? "s" : ""}
        </span>
        {scannedAt && (
          <>
            <span aria-hidden="true" style={{ color: "var(--border-default)" }}>·</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              Scanned {formatRelativeTime(scannedAt)}
            </span>
            <button
              onClick={onRescan}
              disabled={loading}
              style={{
                background: "none", border: "none", padding: 0,
                color: "var(--text-muted)", fontSize: "0.72rem",
                fontFamily: "var(--font-body)", cursor: "pointer",
                textDecoration: "underline", textUnderlineOffset: "2px",
                opacity: loading ? 0.5 : 1,
              }}
            >
              Rescan
            </button>
          </>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      {loading && projects.length === 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px" }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded" />
          ))}
        </div>
      ) : viewMode === "list" ? (
        <>
          {activityError && (
            <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "-8px" }}>
              Activity data unavailable — sparklines may be empty
            </p>
          )}
          <SparklineList
            projects={overlaidProjects}
            activityData={activityData}
            pinnedSlugs={pinnedSlugs}
            onTogglePin={onTogglePin}
          />
        </>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: viewMode === "compact"
              ? "repeat(auto-fill, minmax(240px, 1fr))"
              : "repeat(auto-fill, minmax(320px, 1fr))",
            gap: viewMode === "compact" ? "8px" : "14px",
          }}
        >
          {overlaidProjects.map((project) => (
            <ProjectCard
              key={project.slug}
              project={project}
              onArchive={handleArchive}
              compact={viewMode === "compact"}
              pinned={pinnedSlugs.includes(project.slug)}
              onTogglePin={onTogglePin}
            />
          ))}
          {filtered.length === 0 && (
            <p style={{ gridColumn: "1 / -1", textAlign: "center", color: "var(--text-muted)", padding: "48px 0", fontSize: "0.8rem" }}>
              No projects match.
            </p>
          )}
        </div>
      )}

      {/* ── Archived section ─────────────────────────────────────────────── */}
      {showArchivedSection && (
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => setArchivedExpanded((v) => !v)}
            style={{
              width: "100%", display: "flex", alignItems: "center", gap: "6px",
              padding: "8px 12px",
              background: "transparent", border: "none",
              fontSize: "0.72rem", fontFamily: "var(--font-body)",
              color: "var(--text-muted)", cursor: "pointer",
              textAlign: "left",
            }}
          >
            {archivedExpanded
              ? <ChevronDown style={{ width: "12px", height: "12px", flexShrink: 0 }} />
              : <ChevronRight style={{ width: "12px", height: "12px", flexShrink: 0 }} />
            }
            Archived ({archivedProjects.length})
          </button>
          {archivedExpanded && (
            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                display: "flex", flexDirection: "column",
              }}
            >
              {archivedProjects.map((p, i) => (
                <div
                  key={p.slug}
                  style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "7px 12px",
                    borderTop: i > 0 ? "1px solid var(--border-subtle)" : "none",
                  }}
                >
                  <Link
                    href={`/project/${p.slug}`}
                    style={{
                      flex: 1, minWidth: 0,
                      fontSize: "0.8rem", fontFamily: "var(--font-body)",
                      color: "var(--text-secondary)", textDecoration: "none",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    {p.name}
                  </Link>
                  <button
                    onClick={() => onUnarchive(p.slug)}
                    title="Unarchive"
                    style={{
                      display: "flex", alignItems: "center", gap: "4px",
                      padding: "3px 8px", flexShrink: 0,
                      fontSize: "0.68rem", fontFamily: "var(--font-body)",
                      color: "var(--text-muted)", background: "transparent",
                      border: "1px solid var(--border-subtle)", borderRadius: "3px",
                      cursor: "pointer",
                    }}
                  >
                    <RotateCcw style={{ width: "9px", height: "9px" }} />
                    Unarchive
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <QuickAddTodosModal
        projects={projects}
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />
    </div>
  );
}
