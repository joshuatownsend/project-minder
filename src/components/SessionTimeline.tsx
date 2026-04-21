"use client";

import { useState } from "react";
import { TimelineEvent } from "@/lib/types";
import { User, Bot, Wrench, Brain, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { parseMarkdown, hasCodeFence } from "@/lib/markdown";

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

function RenderedContent({ text }: { text: string }) {
  const segments = parseMarkdown(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "code_block") {
          return (
            <pre
              key={i}
              style={{
                margin: "4px 0",
                padding: "8px 10px",
                background: "var(--bg-base)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "3px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--text-primary)",
                overflowX: "auto",
                whiteSpace: "pre",
                lineHeight: 1.5,
              }}
            >
              <code>{seg.content}</code>
            </pre>
          );
        }
        if (seg.kind === "code_inline") {
          return (
            <code
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.75em",
                background: "var(--bg-base)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "2px",
                padding: "0 3px",
                color: "var(--accent)",
              }}
            >
              {seg.content}
            </code>
          );
        }
        return <span key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{seg.content}</span>;
      })}
    </>
  );
}

function TimelineItem({ event, sessionStart }: { event: TimelineEvent; sessionStart?: string }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = EVENT_CONFIG[event.type];
  const Icon = cfg.icon;
  // Expand threshold: code-heavy content warrants more space before truncation.
  const threshold = hasCodeFence(event.content) ? 400 : 150;
  const isLong = event.content.length > threshold;
  const displayText = isLong && !expanded ? event.content.slice(0, threshold) + "…" : event.content;

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
        <div style={{ fontSize: "0.78rem", color: "var(--text-primary)", lineHeight: 1.5 }}>
          <RenderedContent text={displayText} />
        </div>
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
