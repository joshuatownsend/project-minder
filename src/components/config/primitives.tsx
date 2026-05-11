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

// Project-shared hooks live in `.claude/settings.json`, which is git-tracked.
// Phase 5's toggle deliberately refuses that scope: mutating it would dirty the
// repo for teammates, and Claude Code has no `disabledHooks` runtime affordance
// (hooks are additive — see effectiveConfig.ts:computeEffectiveHooks). A
// `settings.local.json` shadow doesn't work for the same reason. Surface that
// constraint to the user via a faded chip on project-source rows.
export function ProjectSharedHookChip() {
  return (
    <span
      title={
        "Project-shared hooks are git-tracked. Edit .claude/settings.json directly to disable. " +
        "Hooks are additive in Claude Code, so settings.local.json cannot shadow them."
      }
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        color: "var(--text-muted)",
        border: "1px dashed var(--border-subtle)",
        borderRadius: "3px",
        padding: "1px 5px",
        letterSpacing: "0.04em",
        flexShrink: 0,
        opacity: 0.75,
        cursor: "help",
      }}
    >
      edit settings.json
    </span>
  );
}
