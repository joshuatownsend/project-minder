"use client";

import { useState, useEffect, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import type { Swarm, Task } from "@/lib/tasks/types";
import { TASK_STATUS_COLORS } from "@/lib/tasks/types";

export default function SwarmDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [swarm, setSwarm] = useState<Swarm | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useDocumentTitle(swarm ? `Swarm: ${swarm.name}` : "Swarm");

  // Latest-ref pattern: keep `swarmRef` in sync with `swarm` from an
  // effect (not during render — see react-hooks/refs) so the stable
  // 5s poll interval below can read the freshest status without
  // restarting on every status change.
  const swarmRef = useRef<Swarm | null>(null);
  useEffect(() => {
    swarmRef.current = swarm;
  }, [swarm]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/swarms/${id}`);
      if (!res.ok) {
        setError(res.status === 404 ? "Swarm not found" : `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { swarm: Swarm; tasks: Task[] };
      setSwarm(data.swarm);
      setTasks(data.tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load swarm");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Single stable interval; checks status via ref so it doesn't restart on each poll.
  useEffect(() => {
    const interval = setInterval(() => {
      if (swarmRef.current?.status === "running") load();
    }, 5_000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleRemoveWorktrees() {
    setRemoving(true);
    try {
      await fetch(`/api/swarms/${id}/worktrees`, { method: "DELETE" });
    } finally {
      setRemoving(false);
    }
  }

  const totalCost = tasks.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0);
  const members = tasks.filter((t) => t.swarm_role === "member");
  const coordinator = tasks.find((t) => t.swarm_role === "coordinator");

  if (loading) {
    return (
      <div className="shell-content">
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (error || !swarm) {
    return (
      <div className="shell-content">
        <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--danger)", fontSize: "0.85rem" }}>
          {error ?? "Swarm not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="shell-content">
      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <Link href="/swarms" style={{ fontSize: "0.75rem", color: "var(--text-muted)", textDecoration: "none" }}>
          ← Swarms
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "8px" }}>
          <h1 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>{swarm.name}</h1>
          <span
            style={{
              fontSize: "0.7rem",
              padding: "2px 8px",
              borderRadius: "3px",
              background: TASK_STATUS_COLORS[swarm.status as keyof typeof TASK_STATUS_COLORS] ?? "var(--text-muted)",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            {swarm.status}
          </span>
          <span
            style={{
              fontSize: "0.7rem",
              padding: "2px 6px",
              borderRadius: "3px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
            }}
          >
            {swarm.mode}
          </span>
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "4px", fontFamily: "var(--font-mono)" }}>
          {swarm.project_path}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "20px" }}>
        <div style={{ padding: "10px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px" }}>
          <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Tasks</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700 }}>{tasks.length}</div>
        </div>
        <div style={{ padding: "10px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px" }}>
          <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total cost</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
            ${totalCost.toFixed(4)}
          </div>
        </div>
        {swarm.completed_at && (
          <div style={{ padding: "10px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "6px" }}>
            <div style={{ fontSize: "0.68rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Completed</div>
            <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>{new Date(swarm.completed_at).toLocaleString()}</div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        {swarm.mode === "worktree" && (
          <button
            onClick={handleRemoveWorktrees}
            disabled={removing}
            style={{
              padding: "6px 12px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              cursor: removing ? "not-allowed" : "pointer",
              fontSize: "0.78rem",
              color: "var(--text-muted)",
              opacity: removing ? 0.6 : 1,
            }}
          >
            {removing ? "Removing…" : "Remove worktrees"}
          </button>
        )}
      </div>

      {/* Member tasks */}
      <section style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "0.85rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: "10px" }}>
          Member tasks ({members.length})
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {members.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      </section>

      {/* Coordinator task */}
      {coordinator && (
        <section>
          <h2 style={{ fontSize: "0.85rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: "10px" }}>
            Coordinator
          </h2>
          <TaskRow task={coordinator} />
        </section>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const color = TASK_STATUS_COLORS[task.status] ?? "var(--text-muted)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 14px",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "6px",
      }}
    >
      <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ fontWeight: 600, fontSize: "0.85rem", flex: 1 }}>{task.title}</span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{task.status}</span>
      {task.cost_usd != null && (
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          ${task.cost_usd.toFixed(4)}
        </span>
      )}
      {task.session_id && (
        <Link
          href={`/sessions/${task.session_id}`}
          style={{ fontSize: "0.72rem", color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)" }}
        >
          session
        </Link>
      )}
    </div>
  );
}
