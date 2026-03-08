import { TodoInfo } from "@/lib/types";
import { CheckCircle2, Circle } from "lucide-react";

export function TodoList({ todos }: { todos: TodoInfo }) {
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
    </div>
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
