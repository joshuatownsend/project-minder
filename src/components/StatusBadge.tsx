"use client";

import { ProjectStatus } from "@/lib/types";

const statusConfig: Record<
  ProjectStatus,
  { label: string; textVar: string; bgVar: string; borderVar: string }
> = {
  active: {
    label: "Active",
    textVar:   "--status-active-text",
    bgVar:     "--status-active-bg",
    borderVar: "--status-active-border",
  },
  paused: {
    label: "Paused",
    textVar:   "--status-paused-text",
    bgVar:     "--status-paused-bg",
    borderVar: "--status-paused-border",
  },
  archived: {
    label: "Archived",
    textVar:   "--status-archived-text",
    bgVar:     "--status-archived-bg",
    borderVar: "--status-archived-border",
  },
};

interface StatusBadgeProps {
  status: ProjectStatus;
  onClick?: () => void;
}

const statusBadgeStyle = (cfg: { textVar: string; bgVar: string; borderVar: string }, clickable: boolean) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontFamily: "var(--font-body)",
  fontSize: "0.65rem",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase" as const,
  color: `var(${cfg.textVar})`,
  background: `var(${cfg.bgVar})`,
  border: `1px solid var(${cfg.borderVar})`,
  borderRadius: "3px",
  padding: "2px 6px",
  cursor: clickable ? "pointer" : "default",
  userSelect: "none" as const,
  lineHeight: 1.4,
});

const dot = (textVar: string) => ({
  width: "5px",
  height: "5px",
  borderRadius: "50%",
  background: `var(${textVar})`,
  flexShrink: 0,
});

export function StatusBadge({ status, onClick }: StatusBadgeProps) {
  const cfg = statusConfig[status];
  const shared = statusBadgeStyle(cfg, !!onClick);

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{ ...shared, appearance: "none" }}
      >
        <span style={dot(cfg.textVar)} />
        {cfg.label}
      </button>
    );
  }

  return (
    <span style={shared}>
      <span style={dot(cfg.textVar)} />
      {cfg.label}
    </span>
  );
}

interface StatusSelectorProps {
  status: ProjectStatus;
  onSelect: (status: ProjectStatus) => void;
}

export function StatusSelector({ status, onSelect }: StatusSelectorProps) {
  const statuses: ProjectStatus[] = ["active", "paused", "archived"];
  return (
    <div style={{ display: "flex", gap: "4px" }}>
      {statuses.map((s) => (
        <StatusBadge
          key={s}
          status={s}
          onClick={s !== status ? () => onSelect(s) : undefined}
        />
      ))}
    </div>
  );
}
