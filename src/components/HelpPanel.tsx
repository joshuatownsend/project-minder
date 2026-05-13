"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useHelp } from "./HelpProvider";
import { X, ExternalLink, ChevronLeft, BookOpen } from "lucide-react";
import { helpSlugs, type HelpSlug } from "@/lib/help-mapping";
import { MarkdownRenderer } from "./ui/MarkdownRenderer";

const slugTitles: Record<HelpSlug, string> = {
  "getting-started": "Getting Started",
  "search-and-filter": "Search, Filter & Sort",
  "project-details": "Project Details",
  "dev-servers": "Dev Servers",
  ports: "Ports",
  "project-status": "Project Status",
  "tech-stack": "Tech Stack Detection",
  "quick-actions": "Quick Actions",
  "manual-steps": "Manual Steps",
  stats: "Stats Dashboard",
  sessions: "Sessions Browser",
  insights: "Insights",
  agents: "Agents",
  skills: "Skills",
  usage: "Usage Dashboard",
  status: "System Status",
  memory: "Memory Browser",
  "claude-md-audit": "CLAUDE.md Audit & Context",
  config: "Configuration",
  "config-history": "Config History",
  setup: "Setup Guide",
  settings: "Settings",
  templates: "Templates",
  plans: "Plans Browser",
  hooks: "Hooks Browser",
  plugins: "Plugins Browser",
  sql: "SQL Explorer",
  notifications: "Notifications",
  telegram: "Telegram Integration",
  terminal: "Terminal Launch",
  "auto-title": "Auto-title",
  otel: "OpenTelemetry",
  cost: "Cost Settings",
  tasks: "Task Queue & Dispatcher",
  kanban: "Mission Control Kanban",
  adapters: "Adapters",
  "mcp-security": "MCP Security Scanner",
  library: "Library Browser",
  "new-project": "New Project Wizard",
  "insights-report": "Insights Report",
  "command-palette": "Command Palette",
  "mcp-server": "MCP Server",
  "keyboard-shortcuts": "Keyboard Shortcuts",
};

const iconBtnBase: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  border: "none",
  background: "transparent",
  borderRadius: "var(--radius)",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

function IconBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      style={{
        ...iconBtnBase,
        color: hovered ? "var(--text-secondary)" : "var(--text-muted)",
        background: hovered ? "var(--bg-elevated)" : "transparent",
      }}
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}

export function HelpPanel() {
  const { activeSlug, openHelp, closeHelp } = useHelp();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeSlug) {
      setContent("");
      setShowToc(false);
      return;
    }
    setLoading(true);
    setShowToc(false);
    fetch(`/help/${activeSlug}.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((text) => setContent(text))
      .catch(() => setContent("Help document not found."))
      .finally(() => setLoading(false));
  }, [activeSlug]);

  useEffect(() => {
    if (!activeSlug) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHelp();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSlug, closeHelp]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeHelp();
      }
    },
    [closeHelp]
  );

  if (!activeSlug) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "oklch(0 0 0 / 0.55)",
        backdropFilter: "blur(1px)",
      }}
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        className="animate-slide-in-right"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100%",
          width: "100%",
          maxWidth: "460px",
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border-default)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-8px 0 40px oklch(0 0 0 / 0.4)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-base)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1 }}>
            {showToc ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <BookOpen style={{ width: "13px", height: "13px", color: "var(--text-muted)" }} />
                <span style={{
                  fontSize: "0.65rem",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}>
                  Help Index
                </span>
              </div>
            ) : (
              <>
                <IconBtn onClick={() => setShowToc(true)} title="All help topics">
                  <ChevronLeft style={{ width: "14px", height: "14px" }} />
                </IconBtn>
                <span style={{
                  fontSize: "0.72rem",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  letterSpacing: "0.04em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {slugTitles[activeSlug]}
                </span>
              </>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "2px", flexShrink: 0 }}>
            <IconBtn onClick={() => window.open(`/help/${activeSlug}.md`, "_blank")} title="Open in new tab">
              <ExternalLink style={{ width: "12px", height: "12px" }} />
            </IconBtn>
            <IconBtn onClick={closeHelp} title="Close (Esc)">
              <X style={{ width: "14px", height: "14px" }} />
            </IconBtn>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {showToc ? (
            <nav style={{ padding: "12px 0" }}>
              {helpSlugs.map((slug, idx) => {
                const active = slug === activeSlug;
                return (
                  <TocItem
                    key={slug}
                    idx={idx}
                    slug={slug}
                    active={active}
                    label={slugTitles[slug]}
                    onClick={() => {
                      openHelp(slug);
                      setShowToc(false);
                    }}
                  />
                );
              })}
            </nav>
          ) : loading ? (
            <LoadingSkeleton />
          ) : (
            <article style={{ padding: "24px 20px" }}>
              <MarkdownRenderer
                content={content}
                onLinkClick={(href, _e) => {
                  const mdMatch = href.match(/^([a-z-]+)\.md$/);
                  if (mdMatch && helpSlugs.includes(mdMatch[1] as HelpSlug)) {
                    openHelp(mdMatch[1] as HelpSlug);
                    return true;
                  }
                  return false;
                }}
              />
            </article>
          )}
        </div>

        {/* Footer */}
        {!showToc && !loading && (
          <div style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: "0.62rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              <Kbd>Esc</Kbd> to close
            </span>
            <span style={{ fontSize: "0.62rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              <Kbd>?</Kbd> toggles help
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      padding: "1px 5px",
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-default)",
      borderRadius: "3px",
      fontSize: "0.6rem",
      color: "var(--text-secondary)",
      fontFamily: "var(--font-mono)",
      marginRight: "4px",
    }}>
      {children}
    </kbd>
  );
}

function TocItem({
  idx,
  slug,
  active,
  label,
  onClick,
}: {
  idx: number;
  slug: string;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      key={slug}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        width: "100%",
        padding: "8px 16px",
        background: active || hovered ? "var(--bg-elevated)" : "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        color: active ? "var(--accent)" : "var(--text-muted)",
        width: "20px",
        textAlign: "right",
        flexShrink: 0,
      }}>
        {String(idx + 1).padStart(2, "0")}
      </span>
      <span style={{
        fontSize: "0.78rem",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontWeight: active ? 500 : 400,
      }}>
        {label}
      </span>
      {active && (
        <div style={{
          marginLeft: "auto",
          width: "5px",
          height: "5px",
          borderRadius: "50%",
          background: "var(--accent)",
          flexShrink: 0,
        }} />
      )}
    </button>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {[48, 100, 80, 90, 60].map((w, i) => (
        <div key={i} style={{
          height: i === 0 ? "18px" : "12px",
          width: `${w}%`,
          background: "var(--bg-elevated)",
          borderRadius: "3px",
          opacity: 0.7,
        }} />
      ))}
    </div>
  );
}
