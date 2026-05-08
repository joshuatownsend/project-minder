import type React from "react";

export const S = {
  sectionTitle: {
    fontSize: "0.95rem", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 6px 0",
  } as React.CSSProperties,
  desc: {
    fontSize: "0.78rem", color: "var(--text-secondary)", margin: "0 0 20px 0", lineHeight: 1.55,
  } as React.CSSProperties,
  card: {
    padding: "16px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)",
    background: "var(--bg-surface)", marginBottom: "16px",
  } as React.CSSProperties,
  label: { fontSize: "0.82rem", color: "var(--text-primary)", fontWeight: 500 } as React.CSSProperties,
  muted: { fontSize: "0.74rem", color: "var(--text-secondary)", lineHeight: 1.5 } as React.CSSProperties,
  input: {
    width: "100%", boxSizing: "border-box" as const, padding: "6px 10px",
    borderRadius: "var(--radius)", border: "1px solid var(--border-default)",
    background: "var(--bg-elevated)", color: "var(--text-primary)",
    fontSize: "0.82rem", fontFamily: "var(--font-body)",
  } as React.CSSProperties,
  select: {
    width: "100%", boxSizing: "border-box" as const, padding: "6px 28px 6px 10px",
    borderRadius: "var(--radius)", border: "1px solid var(--border-default)",
    background: "var(--bg-elevated)", color: "var(--text-primary)",
    fontSize: "0.82rem", fontFamily: "var(--font-body)", cursor: "pointer",
    appearance: "none" as const, WebkitAppearance: "none" as const,
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 8px center",
  } as React.CSSProperties,
  btn: {
    fontSize: "0.78rem", padding: "5px 12px", borderRadius: "var(--radius)",
    border: "1px solid var(--border-default)", background: "var(--bg-elevated)",
    color: "var(--text-primary)", cursor: "pointer",
  } as React.CSSProperties,
  badge: {
    fontSize: "0.62rem", fontFamily: "var(--font-mono)", padding: "1px 6px",
    borderRadius: "3px", border: "1px solid var(--border-subtle)", color: "var(--text-muted)",
  } as React.CSSProperties,
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
    padding: "10px 12px", borderRadius: "var(--radius)", background: "var(--bg-surface)",
    border: "1px solid var(--border-subtle)", marginBottom: "1px",
  } as React.CSSProperties,
};
