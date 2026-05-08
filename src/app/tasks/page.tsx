"use client";

import { useState, useEffect, useCallback } from "react";
import { TasksBrowser } from "@/components/TasksBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { Task, Schedule } from "@/lib/tasks/types";

export default function TasksPage() {
  useDocumentTitle("Tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tasksRes, schedRes] = await Promise.all([
        fetch("/api/tasks"),
        fetch("/api/schedules"),
      ]);
      if (!tasksRes.ok || !schedRes.ok) throw new Error("Failed to load");
      const [tasksData, schedData] = await Promise.all([
        tasksRes.json() as Promise<{ tasks: Task[] }>,
        schedRes.json() as Promise<{ schedules: Schedule[] }>,
      ]);
      setTasks(tasksData.tasks);
      setSchedules(schedData.schedules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
        Loading tasks…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "48px 0", textAlign: "center", color: "var(--error)", fontSize: "0.85rem" }}>
        {error}
      </div>
    );
  }

  return <TasksBrowser tasks={tasks} schedules={schedules} onRefresh={load} />;
}
