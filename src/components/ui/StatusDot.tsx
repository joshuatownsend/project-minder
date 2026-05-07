"use client";

import type { SessionStatus } from "@/lib/types";

// Superset of SessionStatus for live-activity overlay dots
export type StatusDotStatus = SessionStatus | "live" | "awaiting";

interface StatusDotProps {
  status?: StatusDotStatus;
  size?: number;
}

/**
 * Animated status dot for Working / Needs Attention / Idle session states.
 * Idle renders nothing (no visual noise for the common case).
 */
export function StatusDot({ status, size = 8 }: StatusDotProps) {
  if (!status || status === "idle") return null;

  const color =
    status === "working" || status === "live"
      ? "var(--status-active-text)"
      : "var(--accent)";

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: color,
          opacity: 0.5,
          animation: "ping 1s cubic-bezier(0,0,0.2,1) infinite",
        }}
      />
      <span
        style={{
          position: "relative",
          borderRadius: "50%",
          width: `${size}px`,
          height: `${size}px`,
          background: color,
        }}
      />
    </span>
  );
}
