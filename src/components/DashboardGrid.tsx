"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { ProjectData, ProjectStatus, PortConflict } from "@/lib/types";
import { ProjectCard } from "./ProjectCard";
import { PortConflictBanner } from "./PortConflictBanner";
import { ManageHiddenProjects } from "./ManageHiddenProjects";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Search, RefreshCw, SortAsc, Lightbulb } from "lucide-react";
import { Skeleton } from "./ui/skeleton";
import { QuickAddTodosModal } from "./QuickAddTodosModal";

type SortOption = "activity" | "name" | "claude";

interface DirtyStatusOverride {
  isDirty: boolean;
  uncommittedCount: number;
}

interface DashboardGridProps {
  projects: ProjectData[];
  portConflicts: PortConflict[];
  hiddenCount: number;
  loading: boolean;
  onRescan: () => void;
  onHide: (slug: string, dirName: string) => void;
  gitDirtyOverrides?: Record<string, DirtyStatusOverride>;
}

export function DashboardGrid({
  projects,
  portConflicts,
  hiddenCount,
  loading,
  onRescan,
  onHide,
  gitDirtyOverrides,
}: DashboardGridProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "all">("all");
  const [sortBy, setSortBy] = useState<SortOption>("activity");
  const [showHidden, setShowHidden] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const filtered = useMemo(() => {
    // Apply git dirty status overrides from background cache
    let result = gitDirtyOverrides
      ? projects.map((p) => {
          const override = gitDirtyOverrides[p.slug];
          if (override && p.git) {
            return { ...p, git: { ...p.git, ...override } };
          }
          return p;
        })
      : projects;

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

    if (statusFilter !== "all") {
      result = result.filter((p) => p.status === statusFilter);
    }

    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "claude": {
          const ta = a.claude?.lastSessionDate
            ? new Date(a.claude.lastSessionDate).getTime()
            : 0;
          const tb = b.claude?.lastSessionDate
            ? new Date(b.claude.lastSessionDate).getTime()
            : 0;
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
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inField =
        active?.tagName === "INPUT" || active?.tagName === "TEXTAREA";

      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        if (!inField) {
          e.preventDefault();
          document.getElementById("search-input")?.focus();
        }
      }
      // Shift+T → Quick Add TODOs (don't trigger while typing in a field)
      if (
        e.key === "T" &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !inField
      ) {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "activity", label: "Last Activity" },
    { value: "claude", label: "Last Claude Session" },
    { value: "name", label: "Name" },
  ];

  return (
    <div className="space-y-6">
      <PortConflictBanner conflicts={portConflicts} />

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
          <Input
            id="search-input"
            placeholder="Search projects... (press /)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex gap-2">
          <div className="flex gap-1">
            {(["all", "active", "paused", "archived"] as const).map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? "default" : "outline"}
                size="sm"
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>

          <div className="flex gap-1">
            {sortOptions.map((opt) => (
              <Button
                key={opt.value}
                variant={sortBy === opt.value ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSortBy(opt.value)}
                title={`Sort by ${opt.label}`}
              >
                <SortAsc className="h-3 w-3 mr-1" />
                {opt.label}
              </Button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setQuickAddOpen(true)}
            title="Quick Add TODOs (Shift+T)"
          >
            <Lightbulb className="h-4 w-4 mr-1" />
            Quick Add
          </Button>

          <Button variant="outline" size="sm" onClick={onRescan} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Rescan
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--muted-foreground)]">
          {filtered.length} project{filtered.length !== 1 ? "s" : ""}
          {hiddenCount > 0 && (
            <>
              {" "}
              <button
                onClick={() => setShowHidden(true)}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] underline underline-offset-2 transition-colors"
              >
                ({hiddenCount} hidden)
              </button>
            </>
          )}
        </p>
      </div>

      {loading && projects.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((project) => (
            <ProjectCard key={project.slug} project={project} onHide={onHide} />
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full text-center text-[var(--muted-foreground)] py-12">
              No projects found.
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
