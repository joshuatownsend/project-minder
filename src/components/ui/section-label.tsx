import type { ReactNode } from "react";

interface SectionLabelProps {
  children: ReactNode;
  marginBottom?: string;
}

export function SectionLabel({ children, marginBottom = "12px" }: SectionLabelProps) {
  return (
    <h3
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        fontWeight: 600,
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        marginBottom,
      }}
    >
      {children}
    </h3>
  );
}
