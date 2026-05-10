"use client";

import type { Period } from "@/lib/db/otelQueries";

interface PeriodToggleProps {
  value: Period;
  onChange: (p: Period) => void;
}

// Standard four-option vocabulary used across every period toggle in the app.
// Labels are display-friendly; values are the raw period keys passed to the
// API. Mirrors VALID_PERIODS in src/lib/usage/constants.ts.
const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "all" },
];

export function PeriodToggle({ value, onChange }: PeriodToggleProps) {
  return (
    <div style={{ display: "flex", gap: "4px" }}>
      {PERIODS.map((p) => (
        <button key={p.value} onClick={() => onChange(p.value)} style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          padding: "2px 8px",
          borderRadius: "4px",
          border: `1px solid ${value === p.value ? "var(--accent)" : "var(--border-subtle)"}`,
          background: value === p.value ? "rgba(245,158,11,0.1)" : "transparent",
          color: value === p.value ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
        }}>{p.label}</button>
      ))}
    </div>
  );
}
