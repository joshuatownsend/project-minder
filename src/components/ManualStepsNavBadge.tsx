"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList } from "lucide-react";

export function ManualStepsNavBadge() {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    async function fetchCount() {
      try {
        const res = await fetch("/api/manual-steps?pending=true");
        if (!res.ok) return;
        const data = await res.json();
        const total = data.reduce(
          (sum: number, p: { manualSteps: { pendingSteps: number } }) =>
            sum + p.manualSteps.pendingSteps,
          0
        );
        setPendingCount(total);
      } catch {
        // ignore
      }
    }
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

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
