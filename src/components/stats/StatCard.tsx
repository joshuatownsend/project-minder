import { type ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  detail?: string;
}

export function StatCard({ label, value, icon, detail }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-[var(--card)] p-4 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">
          {label}
        </span>
        {icon && <span className="text-[var(--muted-foreground)]">{icon}</span>}
      </div>
      <p className="text-2xl font-bold font-mono">{value}</p>
      {detail && (
        <p className="text-xs text-[var(--muted-foreground)]">{detail}</p>
      )}
    </div>
  );
}
