import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { SessionsBrowser } from "@/components/SessionsBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchSessions } from "@/lib/server/queries/sessions";

// Reads live session data per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sessions — Project Minder" };

/**
 * Async RSC: when `rscHydration` is on, prefetch the session list server-side
 * and hand the dehydrated cache to the client so `SessionsBrowser` paints with
 * data (no first-mount fetch). When off, `state` is null and the
 * HydrationBoundary is a transparent pass-through — the browser fetches on mount
 * exactly as before.
 */
export default async function SessionsPage() {
  const state = await maybeDehydrate([prefetchSessions]);
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <SessionsBrowser />
      </div>
    </HydrationBoundary>
  );
}
