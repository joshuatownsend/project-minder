import type { ReactNode } from "react";

interface ChartBlockProps {
  title: string;
  children: ReactNode;
}

export function ChartBlock({ title, children }: ChartBlockProps) {
  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius)",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }}>
      <span style={{
        fontSize: "0.65rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
      }}>
        {title}
      </span>
      {children}
    </div>
  );
}
