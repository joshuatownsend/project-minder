"use client";

import { useState } from "react";
import { useProjectBoard } from "@/hooks/useBoard";
import {
  BoardInfo,
  BoardEpic,
  BoardIssue,
  BoardStatus,
} from "@/lib/types";
import { Inbox, Plus, LayoutDashboard } from "lucide-react";
import {
  StatusChip,
  PriorityChip,
  LabelChips,
  ProvenanceChips,
} from "./BoardChips";

const STATUS_OPTIONS: BoardStatus[] = [
  "backlog",
  "todo",
  "doing",
  "review",
  "done",
  "triage",
];

async function postBoard(slug: string, body: unknown): Promise<boolean> {
  const res = await fetch(`/api/board/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

// ── Issue row with an inline status editor ─────────────────────────────────
function IssueRow({
  issue,
  onStatus,
  busy,
}: {
  issue: BoardIssue;
  onStatus: (id: string, status: BoardStatus) => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "7px",
        padding: "6px 0",
        borderBottom: "1px solid var(--border-subtle)",
        flexWrap: "wrap",
        opacity: busy ? 0.5 : 1,
      }}
    >
      {/* Issues without a stable ^i- id can't be targeted by setStatus, so they
          show a read-only chip instead of an editable select. */}
      {issue.id ? (
        <select
          value={issue.status}
          disabled={busy}
          onChange={(e) => onStatus(issue.id, e.target.value as BoardStatus)}
          aria-label="Issue status"
          style={{
            height: "20px",
            fontSize: "0.6rem",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "3px",
            outline: "none",
            cursor: busy ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : (
        <StatusChip status={issue.status} />
      )}
      <span
        style={{
          fontSize: "0.8rem",
          color:
            issue.status === "done" ? "var(--text-muted)" : "var(--text-primary)",
          textDecoration: issue.status === "done" ? "line-through" : "none",
        }}
      >
        {issue.title}
      </span>
      <PriorityChip priority={issue.priority} />
      <LabelChips labels={issue.labels} />
      <ProvenanceChips worktree={issue.worktree} sessionId={issue.sessionId} />
    </div>
  );
}

function EpicBlock({
  epic,
  onStatus,
  busyId,
}: {
  epic: BoardEpic;
  onStatus: (id: string, status: BoardStatus) => void;
  busyId: string | null;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "7px",
          padding: "10px 0 4px",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {epic.title || "(untitled epic)"}
        </span>
        <StatusChip status={epic.status} />
        <PriorityChip priority={epic.priority} />
        <LabelChips labels={epic.labels} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            color: "var(--text-muted)",
          }}
        >
          {epic.issues.length}
        </span>
      </div>
      <div style={{ paddingLeft: "14px" }}>
        {epic.issues.map((issue, i) => (
          <IssueRow
            key={issue.id || `${epic.id}-${i}`}
            issue={issue}
            onStatus={onStatus}
            busy={!!issue.id && busyId === issue.id}
          />
        ))}
      </div>
    </div>
  );
}

interface BoardTabProps {
  slug: string;
  board?: BoardInfo;
}

export function BoardTab({ slug, board: initialBoard }: BoardTabProps) {
  const { data, loading, refresh } = useProjectBoard(slug);
  const board = data ?? initialBoard ?? null;

  const [busyId, setBusyId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const onStatus = async (id: string, status: BoardStatus) => {
    setBusyId(id);
    try {
      await postBoard(slug, { action: "setStatus", id, status });
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const onAdd = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const ok = await postBoard(slug, { action: "addIssue", issue: { title } });
      if (ok) {
        setNewTitle("");
        await refresh();
      }
    } finally {
      setAdding(false);
    }
  };

  if (loading && !board) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            style={{
              height: "56px",
              background: "var(--bg-surface)",
              borderRadius: "var(--radius)",
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    );
  }

  const isEmpty = !board || board.total === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {isEmpty ? (
        <div
          style={{
            padding: "28px 0",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <LayoutDashboard
            style={{
              width: "24px",
              height: "24px",
              color: "var(--text-muted)",
              opacity: 0.3,
            }}
          />
          <p style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            No board yet. Add an issue below to create <code>BOARD.md</code>.
          </p>
        </div>
      ) : (
        <>
          {board!.epics.map((epic, i) => (
            <EpicBlock
              key={epic.id || `epic-${i}`}
              epic={epic}
              onStatus={onStatus}
              busyId={busyId}
            />
          ))}

          {board!.inbox.length > 0 && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "10px 0 4px",
                }}
              >
                <Inbox
                  style={{ width: "12px", height: "12px", color: "var(--text-muted)" }}
                />
                <span
                  style={{
                    fontSize: "0.74rem",
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Inbox
                </span>
              </div>
              <div style={{ paddingLeft: "14px" }}>
                {board!.inbox.map((issue, i) => (
                  <IssueRow
                    key={issue.id || `inbox-${i}`}
                    issue={issue}
                    onStatus={onStatus}
                    busy={!!issue.id && busyId === issue.id}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Add-to-inbox composer */}
      <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
        <input
          type="text"
          placeholder="Add an issue to the Inbox…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onAdd();
          }}
          disabled={adding}
          style={{
            flex: 1,
            height: "32px",
            padding: "0 10px",
            fontSize: "0.78rem",
            fontFamily: "var(--font-body)",
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <button
          onClick={onAdd}
          disabled={adding || !newTitle.trim()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "0 12px",
            height: "32px",
            fontSize: "0.74rem",
            fontFamily: "var(--font-body)",
            color: newTitle.trim() ? "var(--accent-strong)" : "var(--text-muted)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            cursor: newTitle.trim() && !adding ? "pointer" : "default",
            flexShrink: 0,
          }}
        >
          <Plus style={{ width: "12px", height: "12px" }} />
          Add
        </button>
      </div>
    </div>
  );
}
