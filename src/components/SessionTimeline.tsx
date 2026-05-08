"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { TimelineEvent } from "@/lib/types";
import { User, Bot, Wrench, Brain, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { parseMarkdown, hasCodeFence } from "@/lib/markdown";
import { formatToolArgs } from "@/lib/usage/toolArgFormatter";

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const rs = totalSec % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

// One-shot intersection observer: returns true once the element has entered
// the viewport (or come within `rootMargin`) and stays true. Disconnects after
// the first hit so we don't keep observers alive for off-screen items the user
// has already passed. SSR-safe — defaults to `false` until the effect runs.
function useInView(rootMargin = "500px"): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // No IO support — fall back to mounting eagerly so content still renders.
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView];
}

const RenderedContent = memo(function RenderedContent({ text }: { text: string }) {
  // parseMarkdown walks the string once per unique value; React.memo prevents
  // re-running it when the parent re-renders with the same text prop.
  const segments = useMemo(() => parseMarkdown(text), [text]);
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
});

function ThinkingContent({ sessionId, turnIndex, staticContent }: {
  sessionId: string | undefined;
  turnIndex: number | undefined;
  staticContent: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);

  // Empty static content = DB mode placeholder — content must be fetched on expand.
  const needsFetch = !staticContent && sessionId && turnIndex !== undefined;

  async function handleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (needsFetch && !loaded) {
      setLoading(true);
      try {
        const res = await fetch(`/api/sessions/${sessionId}/thinking?turnId=${turnIndex}`);
        if (res.ok) {
          const data = await res.json() as { content: string };
          setFetchedContent(data.content);
        } else {
          setFetchedContent(null);
        }
      } catch {
        setFetchedContent(null);
      } finally {
        setLoaded(true);
        setLoading(false);
      }
    }
  }

  const content = fetchedContent ?? staticContent;

  function displayContent(): string {
    if (loading) return "Loading thinking content…";
    if (loaded && fetchedContent === null) return "Thinking content unavailable for this turn.";
    return content || "Thinking content unavailable for this turn.";
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <button
        onClick={handleExpand}
        style={{ display: "inline-flex", alignItems: "center", gap: "3px", background: "none", border: "none", padding: 0, fontSize: "0.68rem", color: "var(--text-muted)", cursor: "pointer", width: "fit-content" }}
      >
        {expanded
          ? <><ChevronDown style={{ width: "10px", height: "10px" }} /> hide thinking</>
          : <><ChevronRight style={{ width: "10px", height: "10px" }} /> show thinking</>}
      </button>
      {expanded && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", lineHeight: 1.5, fontStyle: "italic", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {displayContent()}
        </div>
      )}
    </div>
  );
}

function TimelineItem({ event, sessionStart, sessionId }: {
  event: TimelineEvent;
  sessionStart?: string;
  sessionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [toolExpanded, setToolExpanded] = useState(false);
  const cfg = EVENT_CONFIG[event.type];
  const Icon = cfg.icon;
  // Expand threshold: code-heavy content warrants more space before truncation.
  const threshold = hasCodeFence(event.content) ? 400 : 150;
  const isLong = event.content.length > threshold;
  const displayText = isLong && !expanded ? event.content.slice(0, threshold) + "…" : event.content;
  const [containerRef, inView] = useInView("500px");

  return (
    <div
      ref={containerRef}
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
          {event.durationMs !== undefined && event.durationMs > 0 && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}
              title="Turn duration">
              ⏱ {formatDuration(event.durationMs)}
            </span>
          )}
          {event.tokenCount && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)" }}>
              {event.tokenCount} tokens
            </span>
          )}
        </div>
        {event.type === "thinking" ? (
          <ThinkingContent
            sessionId={sessionId}
            turnIndex={event.turnIndex}
            staticContent={event.content}
          />
        ) : (
          <>
            <div style={{ fontSize: "0.78rem", color: "var(--text-primary)", lineHeight: 1.5 }}>
              {inView ? (
                <RenderedContent text={displayText} />
              ) : (
                // Off-screen placeholder: plain whitespace-preserving text. Same
                // line-wrap behavior as the parsed output for non-code content, so
                // the swap is layout-stable for the common case.
                <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{displayText}</span>
              )}
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
            {event.type === "tool_use" && event.toolInput && (
              <>
                <button
                  onClick={() => setToolExpanded(!toolExpanded)}
                  style={{ display: "inline-flex", alignItems: "center", gap: "3px", background: "none", border: "none", padding: 0, fontSize: "0.68rem", color: "var(--text-muted)", cursor: "pointer", width: "fit-content" }}
                >
                  {toolExpanded
                    ? <><ChevronDown style={{ width: "10px", height: "10px" }} /> hide args</>
                    : <><ChevronRight style={{ width: "10px", height: "10px" }} /> show args</>}
                </button>
                {toolExpanded && (() => {
                  const formatted = formatToolArgs(event.toolName ?? "", event.toolInput!);
                  return (
                    <pre style={{ margin: "4px 0 0", fontSize: "0.72rem", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-secondary)", background: "var(--bg-surface)", borderRadius: "3px", padding: "6px 8px", lineHeight: 1.5 }}>
                      {formatted.content || formatted.preview}
                    </pre>
                  );
                })()}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SessionTimeline({
  timeline,
  sessionStart,
  sessionId,
}: {
  timeline: TimelineEvent[];
  sessionStart?: string;
  sessionId?: string;
}) {
  if (timeline.length === 0) {
    return <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", textAlign: "center", padding: "32px 0" }}>No timeline events.</p>;
  }
  return (
    <div>
      {timeline.map((event, i) => (
        <TimelineItem key={i} event={event} sessionStart={sessionStart} sessionId={sessionId} />
      ))}
    </div>
  );
}
