"use client";

import Link from "next/link";
import type { KanbanCard as KanbanCardType } from "@/lib/kanban/types";
import { Chip } from "@/components/ui/chip";
import { formatDistanceToNow } from "date-fns";

// ---------------------------------------------------------------------------
// Dot decoration for session live state
// ---------------------------------------------------------------------------

type SessionLiveStatus = Extract<KanbanCardType, { kind: "session" }>["liveStatus"];

const LIVE_DOT: Partial<Record<SessionLiveStatus, { title: string; bg: string }>> = {
  working:  { title: "Working",           bg: "var(--success, #22c55e)" },
  approval: { title: "Awaiting approval", bg: "var(--accent)" },
};

function LiveDot({ liveStatus }: { liveStatus: SessionLiveStatus }) {
  const cfg = LIVE_DOT[liveStatus];
  if (!cfg) return null;
  return (
    <span
      title={cfg.title}
      style={{
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: cfg.bg,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
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
          {card.blockedBy.length > 0 && (
            <Chip
              label={`blocked (${card.blockedBy.length})`}
              muted
              title={`Waiting on task${card.blockedBy.length > 1 ? "s" : ""} #${card.blockedBy.join(", #")}`}
            />
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
