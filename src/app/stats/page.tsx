import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { StatsDashboard } from "@/components/StatsDashboard";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchStats } from "@/lib/server/queries/stats";

// Reads live scan + usage data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stats — Project Minder" };

export default async function StatsPage() {
  const state = await maybeDehydrate([prefetchStats]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <StatsDashboard />
      </div>
    </HydrationBoundary>
  );
}
