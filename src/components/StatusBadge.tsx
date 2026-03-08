"use client";

import { ProjectStatus } from "@/lib/types";
import { Badge } from "./ui/badge";

const statusConfig: Record<ProjectStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800" },
  paused: { label: "Paused", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border-amber-200 dark:border-amber-800" },
  archived: { label: "Archived", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700" },
};

interface StatusBadgeProps {
  status: ProjectStatus;
  onClick?: () => void;
}

export function StatusBadge({ status, onClick }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <Badge
      className={`${config.className} ${onClick ? "cursor-pointer hover:opacity-80" : ""}`}
      onClick={onClick}
    >
      {config.label}
    </Badge>
  );
}

interface StatusSelectorProps {
  status: ProjectStatus;
  onSelect: (status: ProjectStatus) => void;
}

export function StatusSelector({ status, onSelect }: StatusSelectorProps) {
  const statuses: ProjectStatus[] = ["active", "paused", "archived"];

  return (
    <div className="flex gap-1">
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
