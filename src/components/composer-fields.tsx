"use client";

/** Shared form primitives for Task/Swarm composer modals. */

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  fontSize: "0.82rem",
  fontFamily: "var(--font-body)",
  color: "var(--text-primary)",
  outline: "none",
  boxSizing: "border-box",
};

export const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  marginBottom: "4px",
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
