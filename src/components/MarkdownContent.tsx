"use client";

export function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} style={{ fontWeight: 700, color: "var(--text-primary)" }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} style={{
          fontFamily: "var(--font-mono)", fontSize: "0.85em",
          color: "var(--accent)", background: "var(--accent-bg)",
          padding: "1px 5px", borderRadius: "3px",
        }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return part || null;
  }).filter((p): p is NonNullable<typeof p> => p !== null);
}

export function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    const stripped = trimmed.trimStart();
    const indent = raw.length - raw.trimStart().length;

    if (stripped.startsWith("```")) {
      const lang = stripped.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimEnd().trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={key++} style={{
          fontFamily: "var(--font-mono)", fontSize: "0.78rem",
          color: "var(--text-secondary)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          padding: "12px 14px", overflowX: "auto",
          lineHeight: 1.65, margin: "10px 0",
        }}>
          {lang && (
            <span style={{
              display: "block", fontSize: "0.6rem", color: "var(--text-muted)",
              marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.1em",
              fontFamily: "var(--font-body)",
            }}>
              {lang}
            </span>
          )}
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      i++;
      continue;
    }

    if (stripped.startsWith("# ")) {
      elements.push(
        <h2 key={key++} style={{
          fontSize: "0.95rem", fontWeight: 700, color: "var(--text-primary)",
          fontFamily: "var(--font-body)", letterSpacing: "-0.01em",
          margin: "24px 0 8px",
          paddingBottom: "6px",
          borderBottom: "1px solid var(--border-subtle)",
        }}>
          {renderInline(stripped.slice(2))}
        </h2>
      );
      i++;
      continue;
    }

    if (stripped.startsWith("## ")) {
      elements.push(
        <div key={key++} style={{ display: "flex", alignItems: "center", gap: "10px", margin: "20px 0 6px" }}>
          <span style={{
            fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "var(--text-muted)",
            fontFamily: "var(--font-body)", whiteSpace: "nowrap",
          }}>
            {renderInline(stripped.slice(3))}
          </span>
          <div style={{ flex: 1, height: "1px", background: "var(--border-subtle)" }} />
        </div>
      );
      i++;
      continue;
    }

    if (stripped.startsWith("### ")) {
      elements.push(
        <h4 key={key++} style={{
          fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)",
          fontFamily: "var(--font-body)", margin: "14px 0 3px",
        }}>
          {renderInline(stripped.slice(4))}
        </h4>
      );
      i++;
      continue;
    }

    if (stripped.startsWith("#### ")) {
      elements.push(
        <h5 key={key++} style={{
          fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)",
          fontFamily: "var(--font-body)", margin: "10px 0 2px",
        }}>
          {renderInline(stripped.slice(5))}
        </h5>
      );
      i++;
      continue;
    }

    if (/^-{3,}$/.test(stripped) || /^={3,}$/.test(stripped) || /^\*{3,}$/.test(stripped)) {
      elements.push(
        <hr key={key++} style={{
          border: "none",
          borderTop: "1px solid var(--border-subtle)",
          margin: "16px 0",
        }} />
      );
      i++;
      continue;
    }

    if (/^[-*] /.test(stripped)) {
      const items: { text: string; level: number }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const lTrimmed = l.trimEnd();
        const lStripped = lTrimmed.trimStart();
        const lIndent = l.length - l.trimStart().length;
        if (/^[-*] /.test(lStripped)) {
          items.push({ text: lStripped.slice(2), level: Math.floor(lIndent / 2) });
          i++;
        } else if (lTrimmed === "") {
          i++;
          break;
        } else {
          break;
        }
      }
      elements.push(
        <ul key={key++} style={{ margin: "4px 0 6px", padding: 0, listStyle: "none" }}>
          {items.map((item, j) => (
            <li key={j} style={{
              display: "flex", alignItems: "flex-start", gap: "8px",
              fontSize: "0.82rem", color: "var(--text-secondary)",
              lineHeight: 1.6, marginBottom: "2px",
              paddingLeft: `${item.level * 16}px`,
            }}>
              <span style={{
                color: "var(--text-muted)", flexShrink: 0,
                marginTop: "5px", fontSize: "0.45rem",
              }}>
                ◆
              </span>
              <span>{renderInline(item.text)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+\. /.test(stripped)) {
      const items: { text: string; num: string }[] = [];
      while (i < lines.length) {
        const l = lines[i].trimEnd().trimStart();
        const m = l.match(/^(\d+)\. (.+)/);
        if (m) {
          items.push({ num: m[1], text: m[2] });
          i++;
        } else if (lines[i].trim() === "") {
          i++;
          break;
        } else {
          break;
        }
      }
      elements.push(
        <ol key={key++} style={{ margin: "4px 0 6px", padding: 0, listStyle: "none" }}>
          {items.map((item, j) => (
            <li key={j} style={{
              display: "flex", alignItems: "flex-start", gap: "10px",
              fontSize: "0.82rem", color: "var(--text-secondary)",
              lineHeight: 1.6, marginBottom: "3px",
            }}>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: "0.7rem",
                color: "var(--text-muted)", flexShrink: 0,
                minWidth: "18px", textAlign: "right",
                marginTop: "1px",
              }}>
                {item.num}.
              </span>
              <span>{renderInline(item.text)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (indent >= 2 && stripped !== "") {
      elements.push(
        <p key={key++} style={{
          fontSize: "0.8rem", color: "var(--text-muted)",
          lineHeight: 1.6, margin: "0 0 2px",
          paddingLeft: `${Math.min(indent, 8) * 2}px`,
          fontFamily: "var(--font-mono)",
        }}>
          {renderInline(stripped)}
        </p>
      );
      i++;
      continue;
    }

    if (trimmed === "") {
      i++;
      continue;
    }

    elements.push(
      <p key={key++} style={{
        fontSize: "0.82rem", color: "var(--text-secondary)",
        lineHeight: 1.65, margin: "4px 0",
      }}>
        {renderInline(trimmed)}
      </p>
    );
    i++;
  }

  return (
    <div style={{ maxWidth: "720px" }}>
      {elements}
    </div>
  );
}
