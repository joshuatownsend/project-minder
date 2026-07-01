import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { ManualStepsDashboard } from "@/components/ManualStepsDashboard";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchManualSteps } from "@/lib/server/queries/manualSteps";

// Reads live scan data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Manual Steps — Project Minder" };

/**
 * Async RSC: when `rscHydration` is on, prefetch the cross-project manual-steps
 * list server-side and hand the dehydrated cache to the client so
 * `ManualStepsDashboard` paints with data (no first-mount fetch). When off,
 * `state` is null and the HydrationBoundary is a transparent pass-through — the
 * browser fetches on mount exactly as before.
 */
export default async function Page() {
  const state = await maybeDehydrate([prefetchManualSteps]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <ManualStepsDashboard />
      </div>
    </HydrationBoundary>
  );
}
