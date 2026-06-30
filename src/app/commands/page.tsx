import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { CommandsBrowser } from "@/components/CommandsBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchCommands } from "@/lib/server/queries/commands";

// Reads live command catalog per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Commands — Project Minder" };

/**
 * Async RSC: when `rscHydration` is on, prefetch the unfiltered command catalog
 * server-side and hand the dehydrated cache to the client so `CommandsBrowser`
 * paints with data (no first-mount fetch). When off, `state` is null and the
 * HydrationBoundary is a transparent pass-through — the browser fetches on mount
 * exactly as before.
 */
export default async function CommandsPage() {
  const state = await maybeDehydrate([prefetchCommands]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <CommandsBrowser />
      </div>
    </HydrationBoundary>
  );
}
