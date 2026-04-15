"use client";

import { useState } from "react";
import { TimelineEvent } from "@/lib/types";
import { User, Bot, Wrench, Brain, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";

type EventType = TimelineEvent["type"];

const EVENT_CONFIG: Record<EventType, { icon: typeof User; color: string; bg: string }> = {
  user:      { icon: User,         color: "var(--text-secondary)",    bg: "var(--bg-elevated)" },
  assistant: { icon: Bot,          color: "var(--status-active-text)", bg: "var(--status-active-bg)" },
  tool_use:  { icon: Wrench,       color: "var(--accent)",             bg: "var(--accent-bg)" },
  thinking:  { icon: Brain,        color: "var(--text-muted)",         bg: "transparent" },
  error:     { icon: AlertCircle,  color: "var(--status-error-text)",  bg: "var(--status-error-bg)" },
};

function formatOffset(timestamp: string | undefined, sessionStart: string | undefined): string {
  if (!timestamp || !sessionStart) return "";
  const offset = new Date(timestamp).getTime() - new Date(sessionStart).getTime();
  if (offset < 0) return "";
  const seconds = Math.floor(offset / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `+${seconds}s`;
  return `+${minutes}m${seconds % 60}s`;
}

function TimelineItem({ event, sessionStart }: { event: TimelineEvent; sessionStart?: string }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = EVENT_CONFIG[event.type];
  const Icon = cfg.icon;
  const isLong = event.content.length > 150;
  const displayText = isLong && !expanded ? event.content.slice(0, 150) + "…" : event.content;

  return (
    <div
      style={{
        display: "flex",
        gap: "10px",
        padding: "7px 8px",
        borderRadius: "3px",
        background: cfg.bg,
        marginBottom: "2px",
      }}
    >
      <div style={{ color: cfg.color, flexShrink: 0, marginTop: "1px" }}>
        <Icon style={{ width: "13px", height: "13px" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "0.68rem", fontWeight: 600, color: cfg.color, fontFamily: "var(--font-body)" }}>
            {event.type === "tool_use" ? (event.toolName || "Tool") : event.type}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}>
            {formatOffset(event.timestamp, sessionStart)}
          </span>
          {event.tokenCount && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}>
              {event.tokenCount} tokens
            </span>
          )}
        </div>
        <p style={{ fontSize: "0.78rem", color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, lineHeight: 1.5 }}>
          {displayText}
        </p>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{ display: "inline-flex", alignItems: "center", gap: "3px", background: "none", border: "none", padding: 0, fontSize: "0.68rem", color: "var(--text-muted)", cursor: "pointer", width: "fit-content", transition: "color 0.1s" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--text-secondary)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "var(--text-muted)")}
          >
            {expanded
              ? <><ChevronDown style={{ width: "10px", height: "10px" }} /> less</>
              : <><ChevronRight style={{ width: "10px", height: "10px" }} /> more</>}
          </button>
        )}
      </div>
    </div>
  );
}

export function SessionTimeline({ timeline, sessionStart }: { timeline: TimelineEvent[]; sessionStart?: string }) {
  if (timeline.length === 0) {
    return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No timeline events.</p>;
  }
  return (
    <div>
      {timeline.map((event, i) => (
        <TimelineItem key={i} event={event} sessionStart={sessionStart} />
      ))}
    </div>
  );
}
