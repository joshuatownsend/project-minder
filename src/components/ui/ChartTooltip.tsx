"use client";

interface Props { x: number; y: number; content: string; }

export function ChartTooltip({ x, y, content }: Props) {
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        transform: "translate(-50%, -100%)",
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "6px",
        padding: "5px 9px",
        fontSize: "11px",
        color: "var(--text-primary)",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        zIndex: 9999,
      }}
    >
      {content}
    </div>
  );
}
