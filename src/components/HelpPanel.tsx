"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useHelp } from "./HelpProvider";
import { X, ExternalLink, ChevronLeft, BookOpen } from "lucide-react";
import { helpSlugs, type HelpSlug } from "@/lib/help-mapping";

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
  config: "Configuration",
  setup: "Setup Guide",
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
              <MarkdownRenderer content={content} onNavigate={openHelp} />
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

function MarkdownRenderer({
  content,
  onNavigate,
}: {
  content: string;
  onNavigate: (slug: HelpSlug) => void;
}) {
  const elements = parseMarkdown(content);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("data-href") ?? "";
    const mdMatch = href.match(/^([a-z-]+)\.md$/);
    if (mdMatch && helpSlugs.includes(mdMatch[1] as HelpSlug)) {
      e.preventDefault();
      onNavigate(mdMatch[1] as HelpSlug);
    }
  };

  return (
    <div role="presentation" onClick={handleClick} style={{ display: "flex", flexDirection: "column" }}>
      {elements}
    </div>
  );
}

function parseMarkdown(md: string): React.ReactNode[] {
  const lines = md.split("\n");
  const elements: React.ReactNode[] = [];
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  let inList = false;
  let listItems: string[] = [];
  let paragraphLines: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let key = 0;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      elements.push(
        <p key={key++} style={{
          fontSize: "0.82rem",
          lineHeight: 1.65,
          color: "var(--text-secondary)",
          marginBottom: "12px",
          marginTop: 0,
        }}>
          {inlineToReact(paragraphLines.join(" "))}
        </p>
      );
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 12px 0",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
        }}>
          {listItems.map((item, i) => (
            <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span style={{ color: "var(--accent)", fontSize: "0.72rem", flexShrink: 0, marginTop: "3px", fontFamily: "var(--font-mono)" }}>—</span>
              <span style={{ fontSize: "0.82rem", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                {inlineToReact(item)}
              </span>
            </li>
          ))}
        </ul>
      );
      listItems = [];
      inList = false;
    }
  };

  const flushTable = () => {
    if (tableHeaders.length > 0) {
      elements.push(
        <div key={key++} style={{ overflowX: "auto", marginBottom: "16px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
            <thead>
              <tr>
                {tableHeaders.map((h, i) => (
                  <th key={i} style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    borderBottom: "1px solid var(--border-default)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                  }}>
                    {inlineToReact(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{
                      padding: "6px 10px",
                      color: "var(--text-secondary)",
                      borderBottom: ri < tableRows.length - 1 ? "1px solid var(--border-subtle)" : "none",
                      verticalAlign: "top",
                    }}>
                      {inlineToReact(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableHeaders = [];
      tableRows = [];
      inTable = false;
    }
  };

  const flushCode = () => {
    if (codeLines.length > 0) {
      elements.push(
        <div key={key++} style={{ marginBottom: "14px" }}>
          {codeLang && (
            <div style={{
              padding: "4px 10px",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              borderBottom: "none",
              borderRadius: "var(--radius) var(--radius) 0 0",
              fontSize: "0.6rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}>
              {codeLang}
            </div>
          )}
          <pre style={{
            padding: "12px 14px",
            background: "var(--bg-base)",
            border: "1px solid var(--border-subtle)",
            borderRadius: codeLang ? "0 0 var(--radius) var(--radius)" : "var(--radius)",
            overflow: "auto",
            margin: 0,
          }}>
            <code style={{
              fontSize: "0.75rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}>
              {codeLines.join("\n")}
            </code>
          </pre>
        </div>
      );
      codeLines = [];
      codeLang = "";
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        flushParagraph();
        flushList();
        flushTable();
        inCodeBlock = true;
        codeLang = fenceMatch[1];
      } else {
        inCodeBlock = false;
        flushCode();
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushTable();
      const level = headingMatch[1].length;
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;

      if (level === 2) {
        elements.push(
          <div key={key++} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px", marginTop: "22px" }}>
            <span style={{
              fontSize: "0.62rem",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
            }}>
              {inlineToReact(headingMatch[2])}
            </span>
            <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
          </div>
        );
      } else {
        const headingStyles: React.CSSProperties =
          level === 1
            ? { fontSize: "1rem", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px", marginTop: 0, lineHeight: 1.3 }
            : { fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px", marginTop: "16px" };
        elements.push(<Tag key={key++} style={headingStyles}>{inlineToReact(headingMatch[2])}</Tag>);
      }
      continue;
    }

    // Table separator row (skip)
    if (/^\|[\s-:|]+\|$/.test(line)) continue;

    // Table rows
    if (line.startsWith("|") && line.endsWith("|")) {
      flushParagraph();
      flushList();
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (!inTable) {
        tableHeaders = cells;
        inTable = true;
      } else {
        tableRows.push(cells);
      }
      continue;
    }
    if (inTable) flushTable();

    // List items
    const listMatch = line.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      flushParagraph();
      inList = true;
      listItems.push(listMatch[1]);
      continue;
    }
    if (inList && line.trim() === "") {
      flushList();
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();
  if (inCodeBlock) flushCode();

  return elements;
}

function inlineToReact(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  let partKey = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[2]) {
      parts.push(
        <strong key={partKey++} style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      parts.push(
        <code key={partKey++} style={{
          padding: "1px 5px",
          borderRadius: "3px",
          background: "var(--bg-elevated)",
          color: "var(--accent)",
          fontSize: "0.78em",
          fontFamily: "var(--font-mono)",
        }}>
          {match[3]}
        </code>
      );
    } else if (match[4] && match[5]) {
      parts.push(
        <a key={partKey++} data-href={match[5]} style={{
          color: "var(--accent)",
          textDecoration: "underline",
          textDecorationColor: "var(--accent-border)",
          textUnderlineOffset: "2px",
          cursor: "pointer",
        }}>
          {match[4]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}
