import { BoardStatus, BoardPriority } from "@/lib/types";
import { GitBranch } from "lucide-react";

// Shared issue/epic chip vocabulary for the cross-project Board page and the
// per-project Board tab — one place for the status palette so the two views
// never drift. Active states (doing/review/triage) borrow the dashboard's amber
// attention tokens; backlog/done recede into muted text.
const STATUS_STYLE: Record<
  BoardStatus,
  { label: string; color: string; bg?: string; border?: string }
> = {
  backlog: { label: "backlog", color: "var(--text-muted)" },
  todo: { label: "todo", color: "var(--text-secondary)" },
  doing: {
    label: "doing",
    color: "var(--accent-strong)",
    bg: "var(--accent-bg)",
    border: "var(--accent-border)",
  },
  review: {
    label: "review",
    color: "var(--accent)",
    bg: "var(--accent-bg)",
    border: "var(--accent-border)",
  },
  done: { label: "done", color: "var(--text-muted)" },
  triage: {
    label: "triage",
    color: "var(--accent)",
    bg: "var(--accent-bg)",
    border: "var(--accent-border)",
  },
};

export function StatusChip({ status }: { status: BoardStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.todo;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: s.color,
        background: s.bg ?? "transparent",
        border: s.border ? `1px solid ${s.border}` : "1px solid transparent",
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {s.label}
    </span>
  );
}

const PRIORITY_COLOR: Record<BoardPriority, string> = {
  high: "var(--danger)",
  med: "var(--accent)",
  low: "var(--text-muted)",
};

export function PriorityChip({ priority }: { priority?: BoardPriority }) {
  if (!priority) return null;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        fontWeight: 700,
        color: PRIORITY_COLOR[priority],
        flexShrink: 0,
      }}
    >
      !{priority}
    </span>
  );
}

export function LabelChips({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.map((l) => (
        <span
          key={l}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          #{l}
        </span>
      ))}
    </>
  );
}

export function ProvenanceChips({
  worktree,
  sessionId,
}: {
  worktree?: string;
  sessionId?: string;
}) {
  if (!worktree && !sessionId) return null;
  return (
    <>
      {worktree && (
        <span
          title={`worktree: ${worktree}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "2px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          <GitBranch style={{ width: "9px", height: "9px" }} />
          {worktree}
        </span>
      )}
      {sessionId && (
        <span
          title={`session: ${sessionId}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
            opacity: 0.7,
            flexShrink: 0,
          }}
        >
          ~{sessionId.slice(0, 8)}
        </span>
      )}
    </>
  );
}
