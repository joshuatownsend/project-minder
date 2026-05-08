"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import type { TaskQuadrant, RiskLevel, ExecutionMode } from "@/lib/tasks/types";
import { EXECUTION_MODES, EXECUTION_MODE_LABELS } from "@/lib/tasks/types";

interface TaskComposerProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  fontSize: "0.82rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-primary)",
  outline: "none",
  boxSizing: "border-box",
};

const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  marginBottom: "4px",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

export function TaskComposer({ open, onClose, onSuccess }: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [quadrant, setQuadrant] = useState<TaskQuadrant>("do");
  const [priority, setPriority] = useState(3);
  const [assignedSkill, setAssignedSkill] = useState("");
  const [model, setModel] = useState("");
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("low");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("classic");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("Title is required"); return; }
    setError(null);
    setSubmitting(true);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        execution_mode: executionMode,
      };
      if (description.trim()) body.description = description.trim();
      if (quadrant) body.quadrant = quadrant;
      if (priority !== 3) body.priority = priority;
      if (assignedSkill.trim()) body.assigned_skill = assignedSkill.trim();
      if (model.trim()) body.model = model.trim();
      if (riskLevel !== "low") body.risk_level = riskLevel;
      if (requiresApproval) body.requires_approval = true;
      if (dryRun) body.dry_run = true;
      if (scheduledFor) body.scheduled_for = new Date(scheduledFor).toISOString();

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Task" maxWidthClass="max-w-lg">
      <form onSubmit={handleSubmit} style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
        <Field label="Title *">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Describe the task for Claude…"
            style={inputStyle}
            autoFocus
          />
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional context, constraints, or acceptance criteria…"
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Field label="Quadrant">
            <select value={quadrant} onChange={(e) => setQuadrant(e.target.value as TaskQuadrant)} style={selectStyle}>
              <option value="do">Do (urgent + important)</option>
              <option value="schedule">Schedule (important)</option>
              <option value="delegate">Delegate</option>
              <option value="archive">Archive</option>
            </select>
          </Field>

          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} style={selectStyle}>
              <option value={1}>P1 — critical</option>
              <option value={2}>P2 — high</option>
              <option value={3}>P3 — normal</option>
              <option value={4}>P4 — low</option>
              <option value={5}>P5 — someday</option>
            </select>
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Field label="Skill (optional)">
            <input
              type="text"
              value={assignedSkill}
              onChange={(e) => setAssignedSkill(e.target.value)}
              placeholder="e.g. code-review"
              style={inputStyle}
            />
          </Field>

          <Field label="Model (optional)">
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. claude-opus-4-7"
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
          <Field label="Risk level">
            <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as RiskLevel)} style={selectStyle}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>

          <Field label="Execution mode">
            <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)} style={selectStyle}>
              {EXECUTION_MODES.map((m) => (
                <option key={m} value={m}>{EXECUTION_MODE_LABELS[m]}</option>
              ))}
            </select>
          </Field>

          <Field label="Run after (optional)">
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: "flex", gap: "20px", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={requiresApproval}
              onChange={(e) => setRequiresApproval(e.target.checked)}
            />
            Requires approval before running
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            Dry run (log only, no spawn)
          </label>
        </div>

        {error && (
          <div style={{ fontSize: "0.78rem", color: "var(--error)", padding: "8px 10px", background: "color-mix(in srgb, var(--error) 10%, transparent)", borderRadius: "4px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", paddingTop: "4px" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "7px 16px", fontSize: "0.8rem", borderRadius: "4px", cursor: "pointer",
              background: "none", border: "1px solid var(--border)", color: "var(--text-secondary)",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            style={{
              padding: "7px 16px", fontSize: "0.8rem", borderRadius: "4px", cursor: submitting ? "not-allowed" : "pointer",
              background: "var(--accent)", border: "none", color: "white", fontWeight: 600,
              opacity: submitting || !title.trim() ? 0.6 : 1,
            }}
          >
            {submitting ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
