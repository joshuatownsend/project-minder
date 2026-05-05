"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CopyInvocationButtonProps {
  text: string;
  /** Tooltip shown while hovering before copy. Describes what gets copied. */
  title?: string;
}

export function CopyInvocationButton({ text, title }: CopyInvocationButtonProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  return (
    <button
      onClick={handleCopy}
      title={copied ? "Copied!" : (title ?? `Copy: ${text}`)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        padding: "1px 6px",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        background: copied ? "var(--accent-bg)" : "transparent",
        color: copied ? "var(--accent)" : "var(--text-muted)",
        cursor: "pointer",
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        transition: "color 0.12s, background 0.12s",
        flexShrink: 0,
      }}
    >
      {copied ? (
        <Check size={9} strokeWidth={2.5} />
      ) : (
        <Copy size={9} strokeWidth={2} />
      )}
      <span style={{ letterSpacing: "0.04em" }}>{text}</span>
    </button>
  );
}
