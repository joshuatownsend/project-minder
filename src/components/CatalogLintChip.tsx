"use client";

interface CatalogLintChipProps {
  warnings: string[];
}

export function CatalogLintChip({ warnings }: CatalogLintChipProps) {
  if (!warnings || warnings.length === 0) return null;

  return (
    <span
      title={warnings.join("\n")}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        fontWeight: 700,
        color: "var(--warning, #f59e0b)",
        background: "color-mix(in oklch, var(--warning, #f59e0b) 12%, transparent)",
        border: "1px solid color-mix(in oklch, var(--warning, #f59e0b) 35%, transparent)",
        borderRadius: "3px",
        padding: "1px 5px",
        cursor: "help",
        flexShrink: 0,
      }}
    >
      !
    </span>
  );
}
