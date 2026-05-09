"use client";

import Link from "next/link";
import type { KanbanCard as KanbanCardType } from "@/lib/kanban/types";
import { formatDistanceToNow } from "date-fns";

// ---------------------------------------------------------------------------
// Dot decoration for session live state
// ---------------------------------------------------------------------------

type SessionLiveStatus = Extract<KanbanCardType, { kind: "session" }>["liveStatus"];

function LiveDot({ liveStatus }: { liveStatus: SessionLiveStatus }) {
  if (liveStatus === "working") {
    return (
      <span
        title="Working"
        style={{
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          background: "var(--success, #22c55e)",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
    );
  }
  if (liveStatus === "approval") {
    return (
      <span
        title="Awaiting approval"
        style={{
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          background: "var(--accent)",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pill chip
// ---------------------------------------------------------------------------

function Chip({
  label,
  color = "var(--text-muted)",
  muted = false,
}: {
  label: string;
  color?: string;
  muted?: boolean;
}) {
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
        background: muted
          ? "color-mix(in srgb, var(--text-muted) 10%, transparent)"
          : `color-mix(in srgb, ${color} 14%, transparent)`,
        color: muted ? "var(--text-muted)" : color,
        display: "inline-block",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

function CardShell({
  href,
  faded,
  children,
}: {
  href: string;
  faded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        background: "var(--card-bg, hsl(222 14% 11%))",
        border: "1px solid var(--border)",
        borderRadius: "6px",
        padding: "8px 10px",
        opacity: faded ? 0.55 : 1,
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--text-muted)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = "var(--border)";
      }}
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Session card
// ---------------------------------------------------------------------------

type SessionCard = Extract<KanbanCardType, { kind: "session" }>;
type TaskCard = Extract<KanbanCardType, { kind: "task" }>;

function SessionKanbanCard({ card }: { card: SessionCard }) {
  const age = card.mtime
    ? formatDistanceToNow(new Date(card.mtime), { addSuffix: true })
    : null;

  return (
    <CardShell href={`/sessions/${card.sessionId}`}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "6px" }}>
        <LiveDot liveStatus={card.liveStatus} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-primary)",
            }}
          >
            {card.title}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px",
              marginTop: "5px",
              alignItems: "center",
            }}
          >
            <Chip label={card.projectSlug} color="var(--info)" />
            {card.worktreeLabel && (
              <Chip label={card.worktreeLabel} color="var(--accent)" />
            )}
            {card.lastToolName && (
              <Chip label={card.lastToolName} muted />
            )}
            {age && (
              <span style={{ fontSize: "0.65rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                {age}
              </span>
            )}
          </div>
        </div>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Task card
// ---------------------------------------------------------------------------

const QUADRANT_COLOR: Record<string, string> = {
  do:               "var(--success, #22c55e)",
  schedule:         "var(--info)",
  delegate:         "var(--accent)",
  archive:          "var(--text-muted)",
  "delegated-todo": "var(--accent)",
};

function TaskKanbanCard({ card }: { card: TaskCard }) {
  const costLabel = card.costUsd != null
    ? `$${card.costUsd.toFixed(3)}`
    : null;

  return (
    <CardShell href={`/tasks?focus=${card.taskId}`} faded={card.cancelled}>
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        <div
          style={{
            fontSize: "0.8rem",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: card.cancelled ? "var(--text-muted)" : "var(--text-primary)",
          }}
          title={card.title}
        >
          {card.title}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
          <Chip
            label={card.quadrant}
            color={QUADRANT_COLOR[card.quadrant] ?? "var(--text-muted)"}
          />
          {card.assignedSkill && (
            <Chip label={card.assignedSkill} color="var(--info)" />
          )}
          {card.model && (
            <Chip label={card.model.split("-").slice(0, 2).join("-")} muted />
          )}
          {costLabel && (
            <Chip label={costLabel} muted />
          )}
          {card.decisionCount > 0 && (
            <Chip label={`${card.decisionCount} pending`} color="var(--accent)" />
          )}
          {card.cancelled && (
            <Chip label="cancelled" muted />
          )}
        </div>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Exported discriminated wrapper
// ---------------------------------------------------------------------------

export function KanbanCard({ card }: { card: KanbanCardType }) {
  if (card.kind === "session") return <SessionKanbanCard card={card} />;
  return <TaskKanbanCard card={card} />;
}
