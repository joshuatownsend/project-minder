import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { CostReportDashboard } from "@/components/CostReportDashboard";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchUsage } from "@/lib/server/queries/usage";

// Reads live usage data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cost report — Project Minder" };

export default async function CostsPage() {
  // The dashboard mounts at period="30d" with no project filter — the same
  // cache key `prefetchUsage` warms — so this one prefetch satisfies the
  // initial render.
  const state = await maybeDehydrate([prefetchUsage]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <CostReportDashboard />
      </div>
    </HydrationBoundary>
  );
}
