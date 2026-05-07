"use client";

interface SampleBadgeProps {
  n: number;
  threshold?: number;
}

// Small monospace pill showing sample count.
// Amber when n < threshold (low-confidence data), muted when sufficient.
export function SampleBadge({ n, threshold = 10 }: SampleBadgeProps) {
  const low = n < threshold;
  return (
    <span style={{
      fontFamily: "var(--font-mono)",
      fontSize: "0.62rem",
      padding: "1px 5px",
      borderRadius: "4px",
      background: low ? "rgba(245,158,11,0.15)" : "var(--bg-surface)",
      border: `1px solid ${low ? "rgba(245,158,11,0.4)" : "var(--border-subtle)"}`,
      color: low ? "rgb(217,119,6)" : "var(--text-muted)",
      whiteSpace: "nowrap",
    }}>
      n={n}
    </span>
  );
}
