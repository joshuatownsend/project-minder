"use client";

import { type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  isServer,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";

// Devtools are dev-only: code-split into their own chunk via `next/dynamic` and
// never fetched in production (the render is gated on NODE_ENV below). Loading
// the floating toggle on the client only (`ssr: false`) avoids shipping it in
// the server-rendered HTML.
const ReactQueryDevtools = dynamic(
  () =>
    import("@tanstack/react-query-devtools").then((m) => ({
      default: m.ReactQueryDevtools,
    })),
  { ssr: false },
);

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data is "fresh" for 30s: within that window, remounts and cross-page
        // navigations serve from cache with no network hit (stale-while-revalidate).
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
    },
  });
}

// The browser keeps a single QueryClient for the page lifetime so that React
// Suspense/streaming remounts never discard the cache.
let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (isServer) {
    // On the server, always hand out a fresh client so per-request state can
    // never leak between concurrent renders.
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Wraps the app in a TanStack Query context. Slotted high in the provider tree
 * (above PulseProvider) so every client component below it can call `useQuery`,
 * and so future real-time invalidation (PR 5 SSE) can reach the same client.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
