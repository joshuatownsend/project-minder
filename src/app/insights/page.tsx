import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { InsightsBrowser } from "@/components/InsightsBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchInsights } from "@/lib/server/queries/insights";

// Reads live INSIGHTS.md scan data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insights — Project Minder" };

export default async function InsightsPage() {
  const state = await maybeDehydrate([prefetchInsights]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <InsightsBrowser />
      </div>
    </HydrationBoundary>
  );
}
