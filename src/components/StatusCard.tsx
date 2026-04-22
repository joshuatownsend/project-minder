"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import type { LiveSession, LiveSessionStatus } from "@/lib/types";

const STATUS_COLOR: Record<LiveSessionStatus, string> = {
  working:  "#4ade80",
  approval: "var(--accent)",
  waiting:  "#60a5fa",
  other:    "var(--text-muted)",
};

function RelativeTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return <span>—</span>;
  return <span>{formatDistanceToNow(d, { addSuffix: true })}</span>;
}

export function StatusCard({ session }: { session: LiveSession }) {
  const color = STATUS_COLOR[session.status];

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "12px",
      padding: "10px 14px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      fontSize: "0.8rem",
    }}>
      {/* Status dot */}
      <span style={{
        width: "7px", height: "7px", borderRadius: "50%",
        background: color, flexShrink: 0,
        boxShadow: session.status !== "other" ? `0 0 6px ${color}` : undefined,
      }} />

      {/* Project name + worktree chip */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        <Link
          href={`/project/${session.projectSlug}`}
          style={{
            color: "var(--text-primary)", fontWeight: 600,
            textDecoration: "none", fontFamily: "var(--font-body)",
            fontSize: "0.82rem",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {session.projectName}
        </Link>
        {session.worktreeLabel && (
          <span style={{
            fontFamily: "var(--font-mono)", fontSize: "0.65rem",
            color: "var(--text-muted)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "3px", padding: "1px 5px",
            whiteSpace: "nowrap", flexShrink: 0,
          }}>
            {session.worktreeLabel}
          </span>
        )}
      </div>

      {/* Last tool */}
      {session.lastToolName && (
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: "0.7rem",
          color: "var(--text-muted)",
          whiteSpace: "nowrap", flexShrink: 0,
        }}>
          {session.lastToolName}
        </span>
      )}

      {/* Relative time */}
      <span style={{
        fontSize: "0.68rem", color: "var(--text-muted)",
        whiteSpace: "nowrap", flexShrink: 0,
      }}>
        <RelativeTime iso={session.mtime} />
      </span>

      {/* Open session link */}
      <Link
        href={`/sessions/${session.sessionId}`}
        style={{
          fontSize: "0.68rem", color: "var(--text-secondary)",
          textDecoration: "none", flexShrink: 0,
          fontFamily: "var(--font-body)",
        }}
      >
        Open →
      </Link>
    </div>
  );
}
