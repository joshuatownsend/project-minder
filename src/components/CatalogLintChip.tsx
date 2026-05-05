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
        color: "var(--accent)",
        background: "var(--accent-bg)",
        border: "1px solid var(--accent-border)",
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
