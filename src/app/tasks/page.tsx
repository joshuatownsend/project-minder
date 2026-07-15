"use client";

import { useState, useEffect, useCallback } from "react";
import { TasksBrowser } from "@/components/TasksBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { Task, Schedule, TaskDecision } from "@/lib/tasks/types";

export default function TasksPage() {
  useDocumentTitle("Tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [decisionCounts, setDecisionCounts] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tasksRes, schedRes, decisionsRes] = await Promise.all([
        fetch("/api/tasks"),
        fetch("/api/schedules"),
        fetch("/api/decisions"),
      ]);
      if (!tasksRes.ok || !schedRes.ok) throw new Error("Failed to load");
      const [tasksData, schedData] = await Promise.all([
        tasksRes.json() as Promise<{ tasks: Task[] }>,
        schedRes.json() as Promise<{ schedules: Schedule[] }>,
      ]);
      setTasks(tasksData.tasks);
      setSchedules(schedData.schedules);

      if (decisionsRes.ok) {
        const decisionsData = (await decisionsRes.json()) as { decisions: TaskDecision[] };
        const counts = new Map<number, number>();
        for (const d of decisionsData.decisions) {
          counts.set(d.task_id, (counts.get(d.task_id) ?? 0) + 1);
        }
        setDecisionCounts(counts);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh in place when a task is created elsewhere in the SPA (e.g. a
  // workflow-launcher chip fired from the global row while already on /tasks).
  useEffect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener("project-minder:tasks-changed", onChanged);
    return () => window.removeEventListener("project-minder:tasks-changed", onChanged);
  }, [load]);

  if (loading) {
    return (
      <div className="shell-content wide">
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Loading tasks…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="shell-content wide">
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--danger)", fontSize: "0.85rem" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="shell-content wide">
      <TasksBrowser
        tasks={tasks}
        schedules={schedules}
        decisionCounts={decisionCounts}
        onRefresh={load}
      />
    </div>
  );
}
