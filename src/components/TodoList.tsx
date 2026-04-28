"use client";

import { useState } from "react";
import { TodoInfo, WorktreeOverlay } from "@/lib/types";
import { CheckCircle2, Circle, Plus, Loader2 } from "lucide-react";
import { WorktreeSection } from "./WorktreeSection";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useToast } from "./ToastProvider";

interface TodoListProps {
  todos: TodoInfo;
  slug?: string;
  onChange?: (updated: TodoInfo) => void;
  worktrees?: WorktreeOverlay[];
}

type FilterMode = "all" | "open" | "done";

export function TodoList({ todos, slug, onChange, worktrees }: TodoListProps) {
  const [filter, setFilter] = useState<FilterMode>("open");
  const [toggling, setToggling] = useState<number | null>(null);
  const { showToast } = useToast();

  const toggleItem = async (lineNumber: number | undefined) => {
    if (!slug || lineNumber == null || toggling != null) return;
    setToggling(lineNumber);
    try {
      const res = await fetch(`/api/todos/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineNumber }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      onChange?.(body.todos as TodoInfo);
    } catch {
      showToast("Failed to update TODO", "Please try again");
    } finally {
      setToggling(null);
    }
  };

  const filtered = todos.items.filter((item) => {
    if (filter === "open") return !item.completed;
    if (filter === "done") return item.completed;
    return true;
  });

  const pct = todos.total > 0 ? (todos.completed / todos.total) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>

      {/* Header + progress */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {/* Filter buttons */}
            {(["all", "open", "done"] as const).map((f) => {
              const active = filter === f;
              const labels = { all: "All", open: "Open", done: "Done" } as const;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    padding: "3px 9px",
                    fontSize: "0.68rem", fontFamily: "var(--font-body)",
                    color: active ? "var(--text-primary)" : "var(--text-muted)",
                    background: active ? "var(--bg-elevated)" : "transparent",
                    border: "1px solid",
                    borderColor: active ? "var(--border-default)" : "var(--border-subtle)",
                    borderRadius: "var(--radius)",
                    cursor: "pointer", lineHeight: 1,
                    transition: "color 0.1s, background 0.1s",
                  }}
                >
                  {labels[f]}
                </button>
              );
            })}
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}>
            {todos.completed}/{todos.total}
          </span>
        </div>

        {/* Progress track */}
        <div style={{ height: "2px", background: "var(--bg-elevated)", borderRadius: "1px", overflow: "hidden" }}>
          <div style={{
            height: "100%", width: "100%",
            transform: `scaleX(${pct / 100})`,
            transformOrigin: "left",
            background: "var(--status-active-text)",
            borderRadius: "1px",
            transition: "transform 0.3s ease",
          }} />
        </div>
      </div>

      {/* Items */}
      <ul style={{ display: "flex", flexDirection: "column", gap: "2px", padding: 0, margin: 0, listStyle: "none" }}>
        {filtered.map((item) => {
          const isToggling = toggling === item.lineNumber;
          const canToggle = slug != null && item.lineNumber != null;
          const itemKey = item.lineNumber != null ? `line-${item.lineNumber}` : `todo-${item.text}`;
          return (
            <li key={itemKey}>
              <button
                type="button"
                onClick={() => canToggle && toggleItem(item.lineNumber)}
                disabled={!canToggle || isToggling}
                style={{
                  display: "flex", alignItems: "flex-start", gap: "8px", padding: "4px 0",
                  width: "100%", border: "none", background: "none", textAlign: "left",
                  cursor: canToggle && !isToggling ? "pointer" : "default",
                  opacity: isToggling ? 0.5 : 1,
                }}
              >
                {item.completed ? (
                  <CheckCircle2 style={{ width: "14px", height: "14px", color: "var(--status-active-text)", flexShrink: 0, marginTop: "1px" }} />
                ) : (
                  <Circle style={{ width: "14px", height: "14px", color: "var(--text-muted)", flexShrink: 0, marginTop: "1px" }} />
                )}
                <span style={{
                  fontSize: "0.82rem", color: item.completed ? "var(--text-muted)" : "var(--text-secondary)",
                  textDecoration: item.completed ? "line-through" : "none",
                  lineHeight: 1.55,
                }}>
                  {item.text}
                </span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li style={{ fontSize: "0.78rem", color: "var(--text-muted)", padding: "8px 0" }}>
            {filter === "all" ? "No TODOs yet." : filter === "open" ? "No open items." : "No completed items."}
          </li>
        )}
      </ul>

      {/* Worktree sections */}
      {worktrees?.map((wt) =>
        wt.todos ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.todos.total}
            itemLabel={wt.todos.total === 1 ? "TODO" : "TODOs"}
          >
            <ul style={{ display: "flex", flexDirection: "column", gap: "2px", padding: 0, margin: 0, listStyle: "none" }}>
              {wt.todos.items
                .filter((item) => {
                  if (filter === "open") return !item.completed;
                  if (filter === "done") return item.completed;
                  return true;
                })
                .map((item, i) => (
                  <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "4px 0" }}>
                    {item.completed ? (
                      <CheckCircle2 style={{ width: "14px", height: "14px", color: "var(--status-active-text)", flexShrink: 0, marginTop: "1px" }} />
                    ) : (
                      <Circle style={{ width: "14px", height: "14px", color: "var(--text-muted)", flexShrink: 0, marginTop: "1px" }} />
                    )}
                    <span style={{
                      fontSize: "0.82rem", color: item.completed ? "var(--text-muted)" : "var(--text-secondary)",
                      textDecoration: item.completed ? "line-through" : "none",
                      lineHeight: 1.55,
                    }}>
                      {item.text}
                    </span>
                  </li>
                ))}
            </ul>
          </WorktreeSection>
        ) : null
      )}

      {/* Add form */}
      {slug && <AddTodoForm slug={slug} onAddedAction={onChange} />}
    </div>
  );
}

export function AddTodoForm({
  slug,
  onAddedAction,
}: {
  slug: string;
  onAddedAction?: (updated: TodoInfo) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/todos/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setText("");
      onAddedAction?.(body.todos as TodoInfo);
      showToast("TODO added", trimmed);
    } catch (err) {
      showToast(
        "Failed to add TODO",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: "8px", paddingTop: "4px" }}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a TODO..."
        maxLength={500}
        disabled={submitting}
      />
      <Button type="submit" size="sm" disabled={submitting || !text.trim()}>
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </Button>
    </form>
  );
}

export function TodoCompact({ todos }: { todos: TodoInfo }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
      <CheckCircle2 style={{ width: "11px", height: "11px" }} />
      <span>{todos.completed}/{todos.total} TODOs</span>
    </div>
  );
}
