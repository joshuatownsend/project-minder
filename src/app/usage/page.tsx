import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { UsageDashboard } from "@/components/UsageDashboard";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchUsage } from "@/lib/server/queries/usage";

// Reads live usage data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Usage — Project Minder" };

export default async function UsagePage() {
  const state = await maybeDehydrate([prefetchUsage]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <UsageDashboard />
      </div>
    </HydrationBoundary>
  );
}
