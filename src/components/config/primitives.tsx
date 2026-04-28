"use client";

import type { ReactNode } from "react";

export type PillTone = "default" | "info" | "warn";

export function Pill({ children, tone = "default" }: { children: ReactNode; tone?: PillTone }) {
  const color =
    tone === "info" ? "var(--info)" : tone === "warn" ? "var(--accent)" : "var(--text-secondary)";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      {children}
    </span>
  );
}

export const inlineCode: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.65rem",
  color: "var(--text-secondary)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "3px",
  padding: "1px 5px",
};

export const mutedMono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.6rem",
  color: "var(--text-muted)",
};

export const metaText: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-body)",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  flexWrap: "wrap",
  minWidth: 0,
};

export function commandPreview(text: string | undefined, total: number, max = 80): string {
  if (!text) return "";
  const trimmed = text.length > max ? text.slice(0, max) + "…" : text;
  return total > 1 ? `${trimmed}  (+${total - 1})` : trimmed;
}

export function fileBasename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
