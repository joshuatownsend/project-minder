"use client";

import { PortConflict } from "@/lib/types";
import { AlertTriangle } from "lucide-react";

export function PortConflictBanner({ conflicts }: { conflicts: PortConflict[] }) {
  if (conflicts.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 p-4 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
        <h3 className="font-medium text-amber-800 dark:text-amber-200">
          Port Conflicts Detected
        </h3>
      </div>
      <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-300">
        {conflicts.map((c) => (
          <li key={c.port}>
            Port <span className="font-mono font-bold">{c.port}</span> ({c.type}):{" "}
            {c.projects.join(", ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
