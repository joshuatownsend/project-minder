import type { Metadata } from "next";
import { Suspense } from "react";
import { HydrationBoundary } from "@tanstack/react-query";
import { ConfigBrowser } from "@/components/ConfigBrowser";
import { maybeDehydrate } from "@/lib/server/prefetch";
import { prefetchConfig } from "@/lib/server/queries/config";

// The active tab is driven by `?type=`, so this page reads per request and is
// never statically prerendered.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Config — Project Minder" };

// Catalog tabs that map to a fetched `/api/claude-config?type=` payload. The
// settings/playground tabs render their own islands and never fetch, so a
// missing or non-catalog `?type=` prefetches nothing — the client mounts on its
// default "settings" tab (which fetches `type=all` for the nav counts itself).
const CATALOG_TYPES = new Set(["hooks", "mcp", "cicd", "plugins", "settingskeys"]);

/**
 * Async RSC: on a catalog deep-link (`?type=hooks`) and with `rscHydration` on,
 * prefetch that tab's payload server-side and hand the dehydrated cache to
 * `ConfigBrowser` so it paints with data (no first-mount fetch). When the flag
 * is off — or the tab is settings/playground — `state` is null/empty and the
 * HydrationBoundary is a transparent pass-through (fetch-on-mount as before).
 */
export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rawType = typeof sp.type === "string" ? sp.type : undefined;
  const catalogType = rawType && CATALOG_TYPES.has(rawType) ? rawType : undefined;
  const project = typeof sp.project === "string" ? sp.project : undefined;

  const state = catalogType
    ? await maybeDehydrate([(qc) => prefetchConfig(qc, catalogType, project)])
    : await maybeDehydrate([]);

  // ConfigBrowser uses useSearchParams() to seed the active tab from `?type=`
  // and the project filter from `?project=`, which forces a Suspense boundary
  // in Next.js 16 prerender.
  return (
    <HydrationBoundary state={state ?? undefined}>
      <div className="shell-content wide">
        <Suspense fallback={null}>
          <ConfigBrowser />
        </Suspense>
      </div>
    </HydrationBoundary>
  );
}
