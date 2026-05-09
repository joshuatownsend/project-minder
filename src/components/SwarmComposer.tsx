"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import type { SwarmMode } from "@/lib/tasks/types";
import { SWARM_MODES } from "@/lib/tasks/types";
import { inputStyle, labelStyle, Field } from "./composer-fields";

interface MemberDraft {
  title: string;
  description: string;
  assigned_skill: string;
}

interface SwarmComposerProps {
  open: boolean;
  onClose: () => void;
  /** Pre-fill project path (from project card). If not provided, shows a text input. */
  projectPath?: string;
}

function emptyMember(): MemberDraft {
  return { title: "", description: "", assigned_skill: "" };
}

export function SwarmComposer({ open, onClose, projectPath: propProjectPath }: SwarmComposerProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SwarmMode>("shared");
  const [projectPath, setProjectPath] = useState(propProjectPath ?? "");
  const [members, setMembers] = useState<MemberDraft[]>([emptyMember(), emptyMember()]);
  const [hasCoordinator, setHasCoordinator] = useState(false);
  const [coordTitle, setCoordTitle] = useState("");
  const [coordDescription, setCoordDescription] = useState("");
  const [coordSkill, setCoordSkill] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setMode("shared");
    setProjectPath(propProjectPath ?? "");
    setMembers([emptyMember(), emptyMember()]);
    setHasCoordinator(false);
    setCoordTitle("");
    setCoordDescription("");
    setCoordSkill("");
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function updateMember(idx: number, patch: Partial<MemberDraft>) {
    setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  function addMember() {
    if (members.length >= 8) return;
    setMembers((prev) => [...prev, emptyMember()]);
  }

  function removeMember(idx: number) {
    if (members.length <= 2) return;
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) { setError("Name is required"); return; }
    if (!projectPath.trim()) { setError("Project path is required"); return; }
    if (members.some((m) => !m.title.trim())) { setError("All member tasks must have a title"); return; }
    if (hasCoordinator && !coordTitle.trim()) { setError("Coordinator title is required"); return; }

    setSubmitting(true);
    try {
      const body = {
        name: name.trim(),
        mode,
        project_path: projectPath.trim(),
        members: members.map((m) => ({
          title: m.title.trim(),
          description: m.description.trim() || undefined,
          assigned_skill: m.assigned_skill.trim() || undefined,
        })),
        coordinator: hasCoordinator
          ? {
              title: coordTitle.trim(),
              description: coordDescription.trim() || undefined,
              assigned_skill: coordSkill.trim() || undefined,
            }
          : undefined,
      };

      const res = await fetch("/api/swarms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Server error (${res.status})`);
        return;
      }

      const data = (await res.json()) as { swarm: { id: number } };
      handleClose();
      router.push(`/swarms/${data.swarm.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Launch Swarm">
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <Field label="Swarm name">
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Auth refactor"
            autoFocus
          />
        </Field>

        {propProjectPath ? (
          <Field label="Project">
            <div style={{ ...inputStyle, color: "var(--text-muted)", cursor: "default" }}>
              {propProjectPath}
            </div>
          </Field>
        ) : (
          <Field label="Project path">
            <input
              style={inputStyle}
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder={"C:\\dev\\my-project"}
            />
          </Field>
        )}

        <Field label="Swarm mode">
          <div style={{ display: "flex", gap: "16px" }}>
            {SWARM_MODES.map((m) => (
              <label key={m} style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "0.82rem" }}>
                <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                {m === "worktree" ? "Worktree (isolated branch per task)" : "Shared (same working directory)"}
              </label>
            ))}
          </div>
        </Field>

        <div>
          <label style={{ ...labelStyle, marginBottom: "8px" }}>
            Member tasks ({members.length}/8)
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {members.map((m, i) => (
              <div
                key={i}
                style={{
                  padding: "10px",
                  background: "var(--bg-elevated, var(--bg-card))",
                  borderRadius: "6px",
                  border: "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>
                    TASK {i + 1}
                  </span>
                  {members.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeMember(i)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "0.75rem" }}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  style={inputStyle}
                  value={m.title}
                  onChange={(e) => updateMember(i, { title: e.target.value })}
                  placeholder="Task title (required)"
                />
                <input
                  style={inputStyle}
                  value={m.description}
                  onChange={(e) => updateMember(i, { description: e.target.value })}
                  placeholder="Description (optional)"
                />
                <input
                  style={inputStyle}
                  value={m.assigned_skill}
                  onChange={(e) => updateMember(i, { assigned_skill: e.target.value })}
                  placeholder="Skill (optional)"
                />
              </div>
            ))}
          </div>
          {members.length < 8 && (
            <button
              type="button"
              onClick={addMember}
              style={{
                marginTop: "8px",
                padding: "6px 12px",
                background: "none",
                border: "1px dashed var(--border)",
                borderRadius: "4px",
                cursor: "pointer",
                color: "var(--text-muted)",
                fontSize: "0.78rem",
                width: "100%",
              }}
            >
              + Add member task
            </button>
          )}
        </div>

        <div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.82rem" }}>
            <input type="checkbox" checked={hasCoordinator} onChange={(e) => setHasCoordinator(e.target.checked)} />
            Add coordinator task (runs after all members complete)
          </label>
          {hasCoordinator && (
            <div
              style={{
                marginTop: "10px",
                padding: "10px",
                background: "var(--bg-elevated, var(--bg-card))",
                borderRadius: "6px",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <input
                style={inputStyle}
                value={coordTitle}
                onChange={(e) => setCoordTitle(e.target.value)}
                placeholder="Coordinator task title (required)"
              />
              <input
                style={inputStyle}
                value={coordDescription}
                onChange={(e) => setCoordDescription(e.target.value)}
                placeholder="Description — member outputs will be appended (optional)"
              />
              <input
                style={inputStyle}
                value={coordSkill}
                onChange={(e) => setCoordSkill(e.target.value)}
                placeholder="Skill (optional)"
              />
            </div>
          )}
        </div>

        {error && (
          <div style={{ color: "var(--error)", fontSize: "0.78rem", padding: "6px 0" }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleClose}
            style={{
              padding: "7px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "0.82rem",
              color: "var(--text-primary)",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "7px 16px",
              background: "var(--accent)",
              border: "none",
              borderRadius: "4px",
              cursor: submitting ? "not-allowed" : "pointer",
              fontSize: "0.82rem",
              color: "#fff",
              fontWeight: 600,
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Launching…" : "Launch Swarm"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
