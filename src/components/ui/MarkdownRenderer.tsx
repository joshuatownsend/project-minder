"use client";

import React from "react";

// Hand-rolled markdown → React renderer. Originally lived inside
// `HelpPanel.tsx` and was extracted for reuse by the agents/skills
// Body tab (Phase 4.1). Supports a subset of GFM:
//
//   - ATX headings `#`/`##`/`###` (H2 is rendered as a section divider —
//     uppercase muted label + horizontal rule)
//   - Fenced code blocks with optional language tag
//   - Bullet lists (`-`/`*`)
//   - Pipe tables with `|---|` separator
//   - Inline: `**bold**`, `` `code` ``, `[label](href)`
//
// The link handler is opt-in: HelpPanel passes `onLinkClick` to wire
// `*.md` links into its slug router; Body tab omits it so links are
// inert (the markdown is informational, not navigational). Either way
// the rendered anchor still exposes a `data-href` attribute so callers
// can attach their own click delegation.

export interface MarkdownRendererProps {
  content: string;
  /** Optional click delegate. Receives the `data-href` value when an
   *  anchor is clicked. Return `true` to indicate the click was handled
   *  (the renderer will then call `preventDefault`). */
  onLinkClick?: (href: string, event: React.MouseEvent) => boolean;
}

export function MarkdownRenderer({ content, onLinkClick }: MarkdownRendererProps) {
  const elements = parseMarkdown(content);

  const handleClick = onLinkClick
    ? (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        const anchor = target.closest("a");
        if (!anchor) return;
        const href = anchor.getAttribute("data-href") ?? "";
        if (onLinkClick(href, e)) e.preventDefault();
      }
    : undefined;

  return (
    <div
      role="presentation"
      onClick={handleClick}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {elements}
    </div>
  );
}

export function parseMarkdown(md: string): React.ReactNode[] {
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
        <p
          key={key++}
          style={{
            fontSize: "0.82rem",
            lineHeight: 1.65,
            color: "var(--text-secondary)",
            marginBottom: "12px",
            marginTop: 0,
          }}
        >
          {inlineToReact(paragraphLines.join(" "))}
        </p>
      );
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul
          key={key++}
          style={{
            listStyle: "none",
            padding: 0,
            margin: "0 0 12px 0",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          {listItems.map((item, i) => (
            <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
              <span
                style={{
                  color: "var(--accent)",
                  fontSize: "0.72rem",
                  flexShrink: 0,
                  marginTop: "3px",
                  fontFamily: "var(--font-mono)",
                }}
              >
                —
              </span>
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
                  <th
                    key={i}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      borderBottom: "1px solid var(--border-default)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      fontWeight: 600,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                    }}
                  >
                    {inlineToReact(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{
                        padding: "6px 10px",
                        color: "var(--text-secondary)",
                        borderBottom:
                          ri < tableRows.length - 1 ? "1px solid var(--border-subtle)" : "none",
                        verticalAlign: "top",
                      }}
                    >
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
            <div
              style={{
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
              }}
            >
              {codeLang}
            </div>
          )}
          <pre
            style={{
              padding: "12px 14px",
              background: "var(--bg-base)",
              border: "1px solid var(--border-subtle)",
              borderRadius: codeLang ? "0 0 var(--radius) var(--radius)" : "var(--radius)",
              overflow: "auto",
              margin: 0,
            }}
          >
            <code
              style={{
                fontSize: "0.75rem",
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                lineHeight: 1.6,
              }}
            >
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
          <div
            key={key++}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "10px",
              marginTop: "22px",
            }}
          >
            <span
              style={{
                fontSize: "0.62rem",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {inlineToReact(headingMatch[2])}
            </span>
            <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
          </div>
        );
      } else {
        const headingStyles: React.CSSProperties =
          level === 1
            ? {
                fontSize: "1rem",
                fontWeight: 600,
                color: "var(--text-primary)",
                marginBottom: "16px",
                marginTop: 0,
                lineHeight: 1.3,
              }
            : {
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "var(--text-secondary)",
                marginBottom: "8px",
                marginTop: "16px",
              };
        elements.push(
          <Tag key={key++} style={headingStyles}>
            {inlineToReact(headingMatch[2])}
          </Tag>
        );
      }
      continue;
    }

    // Table separator row (skip)
    if (/^\|[\s-:|]+\|$/.test(line)) continue;

    // Table rows
    if (line.startsWith("|") && line.endsWith("|")) {
      flushParagraph();
      flushList();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
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

export function inlineToReact(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let partKey = 0;

  for (const match of text.matchAll(regex)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx));
    }

    if (match[2]) {
      parts.push(
        <strong key={partKey++} style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      parts.push(
        <code
          key={partKey++}
          style={{
            padding: "1px 5px",
            borderRadius: "3px",
            background: "var(--bg-elevated)",
            color: "var(--accent)",
            fontSize: "0.78em",
            fontFamily: "var(--font-mono)",
          }}
        >
          {match[3]}
        </code>
      );
    } else if (match[4] && match[5]) {
      parts.push(
        <a
          key={partKey++}
          data-href={match[5]}
          style={{
            color: "var(--accent)",
            textDecoration: "underline",
            textDecorationColor: "var(--accent-border)",
            textUnderlineOffset: "2px",
            cursor: "pointer",
          }}
        >
          {match[4]}
        </a>
      );
    }

    lastIndex = idx + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}
