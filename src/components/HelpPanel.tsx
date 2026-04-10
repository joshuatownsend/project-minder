"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useHelp } from "./HelpProvider";
import { Button } from "./ui/button";
import { X, ExternalLink, ChevronLeft } from "lucide-react";
import { helpSlugs, type HelpSlug } from "@/lib/help-mapping";
import { cn } from "@/lib/utils";

/** Human-readable titles derived from slugs */
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
};

export function HelpPanel() {
  const { activeSlug, openHelp, closeHelp } = useHelp();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch markdown when slug changes
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

  // Close on Escape
  useEffect(() => {
    if (!activeSlug) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHelp();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSlug, closeHelp]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeHelp();
      }
    },
    [closeHelp]
  );

  const popOut = () => {
    if (activeSlug) {
      window.open(`/help/${activeSlug}.md`, "_blank");
    }
  };

  if (!activeSlug) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40"
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        className={cn(
          "fixed top-0 right-0 h-full w-full sm:w-[480px] bg-[var(--background)] border-l border-[var(--border)]",
          "flex flex-col shadow-2xl",
          "animate-slide-in-right"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 min-w-0">
            {showToc ? (
              <h2 className="text-sm font-semibold truncate">Help</h2>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0"
                  onClick={() => setShowToc(true)}
                  title="All help topics"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <h2 className="text-sm font-semibold truncate">
                  {slugTitles[activeSlug]}
                </h2>
              </>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={popOut}
              title="Open in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={closeHelp}
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {showToc ? (
            <nav className="p-4 space-y-1">
              {helpSlugs.map((slug) => (
                <button
                  key={slug}
                  onClick={() => {
                    openHelp(slug);
                    setShowToc(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                    slug === activeSlug
                      ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
                  )}
                >
                  {slugTitles[slug]}
                </button>
              ))}
            </nav>
          ) : loading ? (
            <div className="p-6 space-y-3">
              <div className="h-6 w-48 bg-[var(--muted)] rounded animate-pulse" />
              <div className="h-4 w-full bg-[var(--muted)] rounded animate-pulse" />
              <div className="h-4 w-3/4 bg-[var(--muted)] rounded animate-pulse" />
              <div className="h-4 w-5/6 bg-[var(--muted)] rounded animate-pulse" />
            </div>
          ) : (
            <article className="p-6 help-content">
              <MarkdownRenderer content={content} onNavigate={openHelp} />
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Lightweight markdown-to-React renderer for help docs.
 *
 * Content is fetched exclusively from our own static files in public/help/,
 * never from user input.
 */
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

  return <div className="help-markdown" onClick={handleClick}>{elements}</div>;
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
  let key = 0;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      elements.push(
        <p key={key++} className="text-sm leading-relaxed mb-3 text-[var(--foreground)]">
          {inlineToReact(paragraphLines.join(" "))}
        </p>
      );
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} className="list-disc list-inside space-y-1 my-2 text-sm">
          {listItems.map((item, i) => (
            <li key={i}>{inlineToReact(item)}</li>
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
        <div key={key++} className="overflow-x-auto my-3">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {tableHeaders.map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 border-b border-[var(--border)] text-[var(--muted-foreground)] font-medium">
                    {inlineToReact(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 border-b border-[var(--border)]">
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushTable();
      const level = headingMatch[1].length;
      const cls =
        level === 1
          ? "text-xl font-bold mb-4"
          : level === 2
            ? "text-base font-semibold mt-6 mb-3"
            : "text-sm font-semibold mt-4 mb-2";
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      elements.push(<Tag key={key++} className={cls}>{inlineToReact(headingMatch[2])}</Tag>);
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

    // Empty line
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    // Paragraph text
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();

  return elements;
}

/** Convert inline markdown to React nodes (bold, code, links) */
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
        <strong key={partKey++} className="font-semibold text-[var(--foreground)]">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      parts.push(
        <code
          key={partKey++}
          className="px-1.5 py-0.5 rounded bg-[var(--muted)] text-[var(--foreground)] text-xs font-mono"
        >
          {match[3]}
        </code>
      );
    } else if (match[4] && match[5]) {
      parts.push(
        <a
          key={partKey++}
          data-href={match[5]}
          className="text-blue-400 hover:underline cursor-pointer"
        >
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
