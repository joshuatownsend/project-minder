"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
}

export function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px 4px 10px",
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderBottom: "none",
          borderRadius: "var(--radius) var(--radius) 0 0",
        }}
      >
        <span
          style={{
            fontSize: "0.6rem",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {filename ?? language ?? "\u00a0"}
        </span>
        <button
          onClick={handleCopy}
          title="Copy to clipboard"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "3px 7px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "calc(var(--radius) - 1px)",
            background: copied ? "var(--accent-bg)" : "transparent",
            color: copied ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: "0.6rem",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            transition: "color 0.12s, background 0.12s",
          }}
        >
          {copied ? (
            <Check size={10} strokeWidth={2.5} />
          ) : (
            <Copy size={10} strokeWidth={2} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          padding: "12px 14px",
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "0 0 var(--radius) var(--radius)",
          overflow: "auto",
          margin: 0,
          maxHeight: "480px",
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
          {code}
        </code>
      </pre>
    </div>
  );
}
