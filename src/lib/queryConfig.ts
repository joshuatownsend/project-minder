import type { QueryClientConfig } from "@tanstack/react-query";

/**
 * Shared TanStack Query client defaults.
 *
 * Isomorphic on purpose (no `"use client"`, no `"server-only"`): the browser
 * provider (`QueryProvider`) and the server-side prefetch factory
 * (`src/lib/server/prefetch.ts`) both build a `QueryClient` from these, so a
 * dehydrated server cache and the client that rehydrates it agree on
 * `staleTime`/`gcTime`. If the two diverged, freshly server-fetched data could
 * be considered *stale* the instant the client mounts and trigger an immediate
 * duplicate refetch — exactly the round-trip RSC hydration exists to avoid.
 */
export const queryClientDefaults: QueryClientConfig["defaultOptions"] = {
  queries: {
    // Data is "fresh" for 30s: within that window, remounts and cross-page
    // navigations serve from cache with no network hit (stale-while-revalidate).
    // Server-prefetched data lands with `dataUpdatedAt ≈ now`, so it stays
    // fresh for 30s after hydration — no refetch-on-mount.
    staleTime: 30_000,
    // Inactive (unmounted) query data is garbage-collected after 5 min,
    // keeping browser memory stable on long-lived dashboard sessions.
    gcTime: 5 * 60_000,
    // This is a local dashboard — refetching every query on every window
    // focus is pure noise, so disable it.
    refetchOnWindowFocus: false,
    // The local API rarely fails transiently (a dev-server restart blip at
    // most); retry once rather than the library default of three.
    retry: 1,
  },
};
