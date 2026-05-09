"use client";

import { useState, useEffect, useMemo } from "react";
import { ChevronDown, Eye, EyeOff, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useKanban } from "@/hooks/useKanban";
import { KanbanCard } from "@/components/KanbanCard";
import { TaskDependencyGraph } from "@/components/TaskDependencyGraph";
import { TaskGanttChart } from "@/components/TaskGanttChart";
import type { KanbanColumn, KanbanCard as KanbanCardType, KanbanKindFilter, KanbanPeriod } from "@/lib/kanban/types";
import { KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, KANBAN_COLUMN_EMPTY, KANBAN_KIND_FILTERS } from "@/lib/kanban/types";

type ViewMode = "board" | "dag" | "gantt";
const LS_VIEW_KEY = "minder:kanban:view-mode";

const PAGE_SIZE = 10;
const LS_KEY = "minder:kanban:hidden-columns";
const COLUMN_DOT_COLOR: Record<KanbanColumn, string> = {
  working: "var(--success, #22c55e)",
  waiting: "var(--accent)",
  idle:    "var(--text-muted)",
  done:    "var(--info)",
  error:   "var(--error)",
};

function loadHiddenColumns(): Set<KanbanColumn> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed.filter((c): c is KanbanColumn => (KANBAN_COLUMNS as readonly string[]).includes(c)));
  } catch {
    return new Set();
  }
}

function saveHiddenColumns(hidden: Set<KanbanColumn>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...hidden]));
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

function KanbanColumnSection({
  col,
  cards,
  hidden,
  onToggleHide,
}: {
  col: KanbanColumn;
  cards: KanbanCardType[];
  hidden: boolean;
  onToggleHide: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? cards : cards.slice(0, PAGE_SIZE);
  const remaining = cards.length - PAGE_SIZE;

  return (
    <section
      role="region"
      aria-label={`${KANBAN_COLUMN_LABELS[col]} column — ${cards.length} item${cards.length !== 1 ? "s" : ""}`}
      style={{
        flex: "0 0 260px",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      {/* Column header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "8px",
          padding: "0 2px",
        }}
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: COLUMN_DOT_COLOR[col],
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          {KANBAN_COLUMN_LABELS[col]}
        </span>
        {cards.length > 0 && (
          <span
            style={{
              fontSize: "0.65rem",
              fontWeight: 600,
              color: "var(--text-muted)",
              background: "color-mix(in srgb, var(--text-muted) 12%, transparent)",
              borderRadius: "10px",
              padding: "0 5px",
            }}
          >
            {cards.length}
          </span>
        )}
        <button
          onClick={onToggleHide}
          aria-label={hidden ? `Show ${KANBAN_COLUMN_LABELS[col]} column` : `Hide ${KANBAN_COLUMN_LABELS[col]} column`}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            padding: "2px",
            display: "flex",
            alignItems: "center",
          }}
        >
          {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      </div>

      {/* Cards */}
      {!hidden && (
        <>
          {cards.length === 0 ? (
            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                textAlign: "center",
                padding: "24px 0",
                fontStyle: "italic",
              }}
            >
              {KANBAN_COLUMN_EMPTY[col]}
            </p>
          ) : (
            <ol
              role="list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              }}
            >
              {visible.map((card) => (
                <li
                  key={card.kind === "session" ? `s:${card.sessionId}` : `t:${card.taskId}`}
                  role="listitem"
                >
                  <KanbanCard card={card} />
                </li>
              ))}
            </ol>
          )}

          {!showAll && remaining > 0 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                marginTop: "8px",
                fontSize: "0.72rem",
                color: "var(--text-muted)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px 0",
                textAlign: "center",
                width: "100%",
              }}
            >
              Show {remaining} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function filterCards(
  cards: KanbanCardType[],
  kind: KanbanKindFilter,
  query: string,
): KanbanCardType[] {
  let out = cards;
  if (kind === "sessions") out = out.filter((c) => c.kind === "session");
  if (kind === "tasks")    out = out.filter((c) => c.kind === "task");
  if (query) {
    const q = query.toLowerCase();
    out = out.filter((c) => {
      if (c.kind === "session") {
        return (
          c.projectSlug.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          c.sessionId.toLowerCase().includes(q)
        );
      }
      return c.title.toLowerCase().includes(q);
    });
  }
  return out;
}

export function KanbanBoard() {
  const [period, setPeriod] = useState<KanbanPeriod>("last24h");
  const [kindFilter, setKindFilter] = useState<KanbanKindFilter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [hiddenCols, setHiddenCols] = useState<Set<KanbanColumn>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [mounted, setMounted] = useState(false);

  const { snapshot, loading, error, refresh } = useKanban(period);

  // Load localStorage on client only
  useEffect(() => {
    setHiddenCols(loadHiddenColumns());
    const savedView = localStorage.getItem(LS_VIEW_KEY);
    if (savedView === "dag" || savedView === "gantt") setViewMode(savedView);
    setMounted(true);
  }, []);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const toggleHide = (col: KanbanColumn) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      saveHiddenColumns(next);
      return next;
    });
  };

  const filteredColumns = useMemo(() => {
    const result: Record<KanbanColumn, KanbanCardType[]> = {
      working: [], waiting: [], idle: [], done: [], error: [],
    };
    for (const col of KANBAN_COLUMNS) {
      result[col] = filterCards(snapshot.columns[col], kindFilter, debouncedQuery);
    }
    return result;
  }, [snapshot.columns, kindFilter, debouncedQuery]);

  const totalCards = Object.values(filteredColumns).reduce((s, arr) => s + arr.length, 0);

  if (!mounted) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Dispatcher-disabled banner */}
      {!snapshot.dispatcherEnabled && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
            fontSize: "0.8rem",
            color: "var(--accent)",
          }}
        >
          Dispatcher disabled — task lane hidden. Enable the <strong>taskDispatcher</strong> feature flag in Settings to show tasks.
        </div>
      )}

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px",
          alignItems: "center",
        }}
      >
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: "320px" }}>
          <input
            type="search"
            placeholder="Search cards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search Kanban cards"
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: "0.8rem",
              background: "var(--card-bg, hsl(222 14% 11%))",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        {/* Kind filter */}
        {KANBAN_KIND_FILTERS.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            aria-pressed={kindFilter === k}
            style={{
              padding: "5px 10px",
              fontSize: "0.75rem",
              fontWeight: 600,
              borderRadius: "5px",
              border: "1px solid var(--border)",
              cursor: "pointer",
              background: kindFilter === k
                ? "color-mix(in srgb, var(--info) 15%, transparent)"
                : "transparent",
              color: kindFilter === k ? "var(--info)" : "var(--text-muted)",
            }}
          >
            {k.charAt(0).toUpperCase() + k.slice(1)}
          </button>
        ))}

        {/* View mode toggle */}
        {(["board", "dag", "gantt"] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => {
              setViewMode(mode);
              try { localStorage.setItem(LS_VIEW_KEY, mode); } catch { /* noop */ }
            }}
            aria-pressed={viewMode === mode}
            style={{
              padding: "5px 10px",
              fontSize: "0.75rem",
              fontWeight: 600,
              borderRadius: "5px",
              border: "1px solid var(--border)",
              cursor: "pointer",
              background: viewMode === mode
                ? "color-mix(in srgb, var(--info) 15%, transparent)"
                : "transparent",
              color: viewMode === mode ? "var(--info)" : "var(--text-muted)",
            }}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}

        {/* Period selector */}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as KanbanPeriod)}
          aria-label="Time period"
          style={{
            padding: "5px 8px",
            fontSize: "0.75rem",
            background: "var(--card-bg, hsl(222 14% 11%))",
            border: "1px solid var(--border)",
            borderRadius: "5px",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <option value="last24h">Last 24 h</option>
          <option value="last7d">Last 7 d</option>
          <option value="all">All time</option>
        </select>

        {/* Column visibility */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Toggle column visibility"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "5px 10px",
                fontSize: "0.75rem",
                fontWeight: 600,
                borderRadius: "5px",
                border: "1px solid var(--border)",
                cursor: "pointer",
                background: "transparent",
                color: "var(--text-muted)",
              }}
            >
              Columns <ChevronDown size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {KANBAN_COLUMNS.map((col) => (
              <DropdownMenuItem
                key={col}
                onClick={() => toggleHide(col)}
                style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem" }}
              >
                {hiddenCols.has(col) ? <Eye size={12} /> : <EyeOff size={12} />}
                {KANBAN_COLUMN_LABELS[col]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Refresh + loading */}
        <button
          onClick={() => refresh()}
          aria-label="Refresh Kanban"
          disabled={loading}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            cursor: loading ? "default" : "pointer",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            padding: "4px",
            opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw
            size={14}
            style={{ animation: loading ? "spin 1s linear infinite" : "none" }}
          />
        </button>
      </div>

      {/* Error state */}
      {error && (
        <p
          role="alert"
          style={{
            fontSize: "0.8rem",
            color: "var(--error)",
            padding: "8px 12px",
            border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
            borderRadius: "6px",
          }}
        >
          {error}
        </p>
      )}

      {/* Board — live announcement region for screen readers */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
      >
        {loading ? "Loading Kanban board…" : `Kanban updated. ${totalCards} card${totalCards !== 1 ? "s" : ""} visible.`}
      </div>

      {/* Board / DAG / Gantt */}
      {viewMode === "board" && (
        <div
          style={{
            display: "flex",
            gap: "16px",
            overflowX: "auto",
            paddingBottom: "8px",
            alignItems: "flex-start",
          }}
        >
          {KANBAN_COLUMNS.map((col) => (
            <KanbanColumnSection
              key={col}
              col={col}
              cards={filteredColumns[col]}
              hidden={hiddenCols.has(col)}
              onToggleHide={() => toggleHide(col)}
            />
          ))}
        </div>
      )}

      {viewMode === "dag" && <TaskDependencyGraph snapshot={snapshot} />}
      {viewMode === "gantt" && <TaskGanttChart snapshot={snapshot} />}

      {/* Whole-board empty state (board mode only) */}
      {viewMode === "board" && !loading && totalCards === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "48px 16px",
            color: "var(--text-muted)",
            fontSize: "0.85rem",
          }}
        >
          <p style={{ marginBottom: "8px", fontWeight: 600 }}>No items to show</p>
          <p>
            Start a Claude Code session to see it here, or compose a task in{" "}
            <a href="/tasks" style={{ color: "var(--info)", textDecoration: "none" }}>Tasks</a>.
          </p>
        </div>
      )}
    </div>
  );
}
