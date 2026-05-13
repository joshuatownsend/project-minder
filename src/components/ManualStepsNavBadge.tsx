"use client";

import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { usePulse } from "@/components/PulseProvider";

export function ManualStepsNavBadge() {
  const { snapshot } = usePulse();
  const pendingCount = snapshot.pendingSteps;

  return (
    <Link
      href="/manual-steps"
      className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
    >
      <ClipboardList className="h-4 w-4" />
      <span>Manual Steps</span>
      {pendingCount > 0 && (
        <span className="bg-amber-500/20 text-amber-400 text-xs px-1.5 py-0.5 rounded-full font-medium">
          {pendingCount}
        </span>
      )}
    </Link>
  );
}
