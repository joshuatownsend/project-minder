"use client";

export function Chip({
  label,
  color = "var(--text-muted)",
  muted = false,
  title,
}: {
  label: string;
  color?: string;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        fontSize: "0.6rem",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "1px 5px",
        borderRadius: "3px",
        background: muted
          ? "color-mix(in srgb, var(--text-muted) 10%, transparent)"
          : `color-mix(in srgb, ${color} 14%, transparent)`,
        color: muted ? "var(--text-muted)" : color,
        display: "inline-block",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
