"use client";

import type { Period } from "@/lib/db/otelQueries";

interface PeriodToggleProps {
  value: Period;
  onChange: (p: Period) => void;
}

const PERIODS: Period[] = ["today", "7d", "30d"];

export function PeriodToggle({ value, onChange }: PeriodToggleProps) {
  return (
    <div style={{ display: "flex", gap: "4px" }}>
      {PERIODS.map((p) => (
        <button key={p} onClick={() => onChange(p)} style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          padding: "2px 8px",
          borderRadius: "4px",
          border: `1px solid ${value === p ? "var(--accent)" : "var(--border-subtle)"}`,
          background: value === p ? "rgba(245,158,11,0.1)" : "transparent",
          color: value === p ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
        }}>{p}</button>
      ))}
    </div>
  );
}
