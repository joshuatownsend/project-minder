import type { Metadata } from "next";
import { HydrationBoundary } from "@tanstack/react-query";
import { TemplatesBrowser } from "@/components/TemplatesBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchTemplates } from "@/lib/server/queries/templates";

// Reads live template manifests per request — never statically prerender.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Templates — Project Minder" };

/**
 * Async RSC: when `rscHydration` is on, prefetch the template list server-side
 * and hand the dehydrated cache to the client so `TemplatesBrowser` paints with
 * data (no first-mount fetch). When off, `state` is null and the
 * HydrationBoundary is a transparent pass-through — the browser fetches on mount
 * exactly as before.
 */
export default async function TemplatesPage() {
  return (
    <HydrationBoundary state={(await maybeDehydrate([prefetchTemplates])) ?? undefined}>
      <div className="shell-content wide">
        <TemplatesBrowser />
      </div>
    </HydrationBoundary>
  );
}
