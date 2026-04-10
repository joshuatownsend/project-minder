"use client";

import { useState } from "react";
import { Badge } from "./ui/badge";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";

interface WorktreeSectionProps {
  branch: string;
  itemCount: number;
  itemLabel: string; // e.g. "TODOs", "steps", "insights"
  children: React.ReactNode;
}

export function WorktreeSection({
  branch,
  itemCount,
  itemLabel,
  children,
}: WorktreeSectionProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-l-2 border-blue-500/30 pl-3 mt-4">
      <button
        className="flex items-center gap-2 w-full text-left py-2 hover:bg-[var(--muted)] rounded px-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        )}
        <GitBranch className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <Badge variant="secondary" className="text-xs font-mono px-2 py-0">
          {branch}
        </Badge>
        <span className="text-xs text-[var(--muted-foreground)]">
          {itemCount} {itemLabel}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-[var(--muted-foreground)] italic px-2">
            Read-only — from active worktree
          </p>
          {children}
        </div>
      )}
    </div>
  );
}
