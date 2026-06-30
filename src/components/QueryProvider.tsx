"use client";

import { type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  isServer,
} from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { queryClientDefaults } from "@/lib/queryConfig";

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
  // Defaults live in an isomorphic module so the server-side prefetch factory
  // (src/lib/server/prefetch.ts) builds an identically-configured client — a
  // dehydrated server cache and this client must agree on staleTime/gcTime.
  return new QueryClient({ defaultOptions: queryClientDefaults });
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
