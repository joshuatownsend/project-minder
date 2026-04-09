"use client";

import { useState } from "react";
import { TodoInfo } from "@/lib/types";
import { CheckCircle2, Circle, Plus, Loader2 } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useToast } from "./ToastProvider";

interface TodoListProps {
  todos: TodoInfo;
  slug?: string;
  onChange?: (updated: TodoInfo) => void;
}

export function TodoList({ todos, slug, onChange }: TodoListProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">TODOs</h3>
        <span className="text-xs text-[var(--muted-foreground)]">
          {todos.completed}/{todos.total} completed
        </span>
      </div>

      <div className="w-full bg-[var(--muted)] rounded-full h-2">
        <div
          className="bg-emerald-500 h-2 rounded-full transition-all"
          style={{ width: `${todos.total > 0 ? (todos.completed / todos.total) * 100 : 0}%` }}
        />
      </div>

      <ul className="space-y-1">
        {todos.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {item.completed ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
            )}
            <span className={item.completed ? "line-through text-[var(--muted-foreground)]" : ""}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>

      {slug && <AddTodoForm slug={slug} onAdded={onChange} />}
    </div>
  );
}

export function AddTodoForm({
  slug,
  onAdded,
}: {
  slug: string;
  onAdded?: (updated: TodoInfo) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  const submit = async (e: React.FormEvent) => {
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
      onAdded?.(body.todos as TodoInfo);
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
    <form onSubmit={submit} className="flex gap-2 pt-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a new TODO..."
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
    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <CheckCircle2 className="h-3 w-3" />
      <span>
        {todos.completed}/{todos.total} TODOs
      </span>
    </div>
  );
}
