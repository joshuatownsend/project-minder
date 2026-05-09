"use client";

import { useState, useMemo } from "react";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Circle,
  XCircle,
  HelpCircle,
  Plus,
} from "lucide-react";
import type { Task, Schedule, TaskStatus, TaskQuadrant } from "@/lib/tasks/types";
import { TASK_STATUSES, TASK_QUADRANTS, TASK_STATUS_COLORS } from "@/lib/tasks/types";
import { TaskComposer } from "./TaskComposer";
import { SwarmComposer } from "./SwarmComposer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending:            "Pending",
  awaiting_approval:  "Awaiting approval",
  running:            "Running",
  done:               "Done",
  failed:             "Failed",
  cancelled:          "Cancelled",
};


const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function StatusIcon({ status }: { status: TaskStatus }) {
  const style = { width: "12px", height: "12px", color: TASK_STATUS_COLORS[status] };
  switch (status) {
    case "pending":           return <Circle style={style} />;
    case "awaiting_approval": return <HelpCircle style={style} />;
    case "running":           return <Loader2 style={{ ...style, animation: REDUCED_MOTION ? "none" : "spin 1s linear infinite" }} />;
    case "done":              return <CheckCircle2 style={style} />;
    case "failed":            return <AlertCircle style={style} />;
    case "cancelled":         return <XCircle style={style} />;
  }
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span
      style={{
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "1px 5px",
        borderRadius: "3px",
        background: `color-mix(in srgb, ${TASK_STATUS_COLORS[status]} 12%, transparent)`,
        color: TASK_STATUS_COLORS[status],
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
      }}
    >
      <StatusIcon status={status} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: number }) {
  const labels = ["", "P1", "P2", "P3", "P4", "P5"];
  const colors = ["", "var(--error)", "var(--accent)", "var(--text-secondary)", "var(--text-muted)", "var(--text-muted)"];
  return (
    <span
      style={{
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        color: colors[priority] ?? "var(--text-muted)",
      }}
    >
      {labels[priority] ?? `P${priority}`}
    </span>
  );
}

function QuadrantBadge({ quadrant }: { quadrant: string }) {
  const labels: Record<string, string> = {
    do: "Do", schedule: "Schedule", delegate: "Delegate", archive: "Archive",
  };
  return (
    <span style={{ fontSize: "0.6rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
      {labels[quadrant] ?? quadrant}
    </span>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// TaskRow
// ---------------------------------------------------------------------------

function TaskRow({ task, expanded, onToggle, pendingDecisions }: {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  pendingDecisions?: number;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <button
        style={{
          display: "flex", alignItems: "center", gap: "8px", padding: "10px 0",
          cursor: "pointer", width: "100%", background: "none", border: "none", textAlign: "left",
        }}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded
            ? <ChevronDown style={{ width: "12px", height: "12px" }} />
            : <ChevronRight style={{ width: "12px", height: "12px" }} />
          }
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 500, color: "var(--text-primary)" }}>
              {task.title}
            </span>
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <QuadrantBadge quadrant={task.quadrant} />
            {pendingDecisions != null && pendingDecisions > 0 && (
              <span style={{
                fontSize: "0.6rem",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                padding: "1px 5px",
                borderRadius: "3px",
                background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                color: "var(--accent)",
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
              }}>
                ⏸ {pendingDecisions} waiting
              </span>
            )}
          </div>
          {task.description && !expanded && (
            <p style={{ margin: "3px 0 0", fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>
              {task.description.length > 120 ? task.description.slice(0, 120) + "…" : task.description}
            </p>
          )}
        </div>

        <div style={{ flexShrink: 0, fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {formatDate(task.created_at)}
        </div>
      </button>

      {expanded && (
        <div
          style={{
            padding: "10px 20px 14px",
            background: "var(--surface-raised, var(--bg-card))",
            borderRadius: "4px",
            marginBottom: "4px",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 24px", fontSize: "0.75rem" }}>
            <Detail label="Status" value={<StatusBadge status={task.status} />} />
            <Detail label="Priority" value={<PriorityBadge priority={task.priority} />} />
            <Detail label="Quadrant" value={<QuadrantBadge quadrant={task.quadrant} />} />
            <Detail label="Execution" value={task.execution_mode} />
            <Detail label="Risk" value={task.risk_level} />
            <Detail label="Approval required" value={task.requires_approval ? "Yes" : "No"} />
            {task.assigned_skill && <Detail label="Skill" value={task.assigned_skill} />}
            {task.model && <Detail label="Model" value={task.model} />}
            {task.scheduled_for && <Detail label="Scheduled for" value={formatDate(task.scheduled_for)} />}
            {task.session_id && <Detail label="Session" value={task.session_id} mono />}
            {task.started_at && <Detail label="Started" value={formatDate(task.started_at)} />}
            {task.completed_at && <Detail label="Completed" value={formatDate(task.completed_at)} />}
            {task.duration_ms != null && <Detail label="Duration" value={`${(task.duration_ms / 1000).toFixed(1)}s`} />}
            {task.cost_usd != null && <Detail label="Cost" value={`$${task.cost_usd.toFixed(4)}`} />}
            {task.error_message && <Detail label="Error" value={task.error_message} />}
          </div>
          {task.description && (
            <div style={{ marginTop: "10px" }}>
              <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Description</span>
              <p style={{ margin: "4px 0 0", fontSize: "0.78rem", color: "var(--text-secondary)", whiteSpace: "pre-wrap", fontFamily: "var(--font-body)" }}>
                {task.description}
              </p>
            </div>
          )}
          {task.output_summary && (
            <div style={{ marginTop: "10px" }}>
              <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Output</span>
              <p style={{ margin: "4px 0 0", fontSize: "0.75rem", color: "var(--text-secondary)", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
                {task.output_summary}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "2px" }}>
        {label}
      </div>
      <div style={{ fontSize: "0.78rem", color: "var(--text-secondary)", fontFamily: mono ? "var(--font-mono)" : undefined }}>
        {value ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
      </div>
    </div>
  );
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 0",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: "0.78rem",
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          flexShrink: 0,
          background: schedule.enabled ? "var(--success, #22c55e)" : "var(--text-muted)",
        }}
      />
      <span style={{ flex: 1, color: "var(--text-primary)", fontWeight: 500 }}>{schedule.name}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
        {schedule.cron_expression}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{schedule.task_title}</span>
      {schedule.next_run_at && (
        <span style={{ display: "flex", alignItems: "center", gap: "3px", color: "var(--text-muted)", fontSize: "0.68rem" }}>
          <Clock style={{ width: "10px", height: "10px" }} />
          {formatDate(schedule.next_run_at)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main browser
// ---------------------------------------------------------------------------

type SortKey = "created_at" | "priority" | "scheduled_for";

const SELECT_STYLE: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  padding: "4px 8px",
  fontSize: "0.72rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

interface Props {
  tasks: Task[];
  schedules: Schedule[];
  decisionCounts?: Map<number, number>;
  onRefresh?: () => void;
}

export function TasksBrowser({ tasks, schedules, decisionCounts, onRefresh }: Props) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [quadrantFilter, setQuadrantFilter] = useState<TaskQuadrant | "">("");
  const [sourceFilter, setSourceFilter] = useState<"" | "todo">("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [composerOpen, setComposerOpen] = useState(false);
  const [swarmComposerOpen, setSwarmComposerOpen] = useState(false);

  const filtered = useMemo(() => {
    let result = tasks;
    if (statusFilter) result = result.filter((t) => t.status === statusFilter);
    if (quadrantFilter) result = result.filter((t) => t.quadrant === quadrantFilter);
    if (sourceFilter === "todo") result = result.filter((t) => t.quadrant === "delegated-todo");
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q) ||
          (t.assigned_skill ?? "").toLowerCase().includes(q)
      );
    }
    const sorted = [...result];
    sorted.sort((a, b) => {
      if (sortKey === "priority") return a.priority - b.priority;
      if (sortKey === "scheduled_for") {
        if (!a.scheduled_for) return 1;
        if (!b.scheduled_for) return -1;
        return a.scheduled_for.localeCompare(b.scheduled_for);
      }
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    return sorted;
  }, [tasks, statusFilter, quadrantFilter, sourceFilter, query, sortKey]);

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: "340px" }}>
          <Search
            style={{
              position: "absolute",
              left: "8px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "12px",
              height: "12px",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
          />
          <input
            type="search"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "5px 8px 5px 26px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              fontSize: "0.8rem",
              fontFamily: "var(--font-body)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "")} style={SELECT_STYLE}>
          <option value="">All statuses</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>

        <select value={quadrantFilter} onChange={(e) => setQuadrantFilter(e.target.value as TaskQuadrant | "")} style={SELECT_STYLE}>
          <option value="">All quadrants</option>
          {TASK_QUADRANTS.map((q) => (
            <option key={q} value={q} style={{ textTransform: "capitalize" }}>{q}</option>
          ))}
        </select>

        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as "" | "todo")} style={SELECT_STYLE}>
          <option value="">All sources</option>
          <option value="todo">From TODOs</option>
        </select>

        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} style={SELECT_STYLE}>
          <option value="created_at">Sort: newest</option>
          <option value="priority">Sort: priority</option>
          <option value="scheduled_for">Sort: scheduled</option>
        </select>

        <span style={{ fontSize: "0.68rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {filtered.length} / {tasks.length}
        </span>

        <div style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
          <button
            onClick={() => setSwarmComposerOpen(true)}
            style={{
              display: "flex", alignItems: "center", gap: "5px",
              padding: "5px 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              fontSize: "0.78rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            Launch Swarm
          </button>
          <button
            onClick={() => setComposerOpen(true)}
            style={{
              display: "flex", alignItems: "center", gap: "5px",
              padding: "5px 12px",
              background: "var(--accent)",
              border: "none",
              borderRadius: "4px",
              fontSize: "0.78rem",
              fontWeight: 600,
              color: "white",
              cursor: "pointer",
            }}
          >
            <Plus style={{ width: "12px", height: "12px" }} />
            New task
          </button>
        </div>
      </div>

      <TaskComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onSuccess={() => {
          setComposerOpen(false);
          onRefresh?.();
        }}
      />
      <SwarmComposer
        open={swarmComposerOpen}
        onClose={() => setSwarmComposerOpen(false)}
      />

      {/* Tasks list */}
      {tasks.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "8px" }}>📋</div>
          <div style={{ fontWeight: 500, marginBottom: "4px" }}>No tasks yet</div>
          <div style={{ fontSize: "0.75rem" }}>
            Create a task with &ldquo;New task&rdquo; — the dispatcher will pick it up and run it with Claude Code.
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)", fontSize: "0.8rem" }}>
          No tasks match your filters.
        </div>
      ) : (
        <>
          {filtered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={expandedIds.has(task.id)}
              onToggle={() => toggleExpand(task.id)}
              pendingDecisions={decisionCounts?.get(task.id)}
            />
          ))}
        </>
      )}

      {/* Schedules sub-section */}
      {schedules.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <div style={{
            fontSize: "0.68rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            padding: "12px 0 6px",
            borderTop: "1px solid var(--border-subtle)",
          }}>
            Schedules ({schedules.length})
          </div>
          {schedules.map((s) => <ScheduleRow key={s.id} schedule={s} />)}
        </div>
      )}
    </div>
  );
}
