"use client";

import { useCallback } from "react";
import {
  useQueryClient,
  type FetchQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";

/**
 * Returns a `prefetch(options)` callback that warms the TanStack Query cache
 * for a query the user is *about* to need — typically on `mouseenter`/`focus`
 * of a nav link or list row.
 *
 * Why this exists: our route pages are `"use client"` and fetch their data in
 * `useQuery` after mount, so Next.js's built-in `<Link>` prefetch (which warms
 * the route bundle + RSC payload) leaves the actual API data cold. Warming the
 * query on hover means the destination page often mounts with data already in
 * cache — the on-mount `useQuery` resolves from cache instead of waiting on a
 * round-trip.
 *
 * Two properties make this safe to sprinkle liberally onto hover handlers:
 *   - it is **staleTime-aware**: if the same key was fetched within the
 *     client's `staleTime` (30s), the call is a no-op — no redundant network
 *     request from rapid hovering. Note `prefetchQuery` does *not* apply the
 *     client's default `staleTime` on its own (only a value passed to the call
 *     itself dedupes), so we read the client default and pass it through.
 *   - errors are **swallowed**: a prefetch is best-effort, so a failed warm
 *     must never surface. The real `useQuery` on the destination page owns
 *     error reporting and retries. (`prefetchQuery` already resolves rather
 *     than rejects; the `.catch` is belt-and-suspenders.)
 *
 * Pass it a factory result from `@/lib/queryOptions` so the warmed request is
 * byte-for-byte the request the page's hook will make.
 */

// Used only when the client default `staleTime` is unset or non-numeric (e.g.
// a function or 'static'); our QueryProvider sets a plain 30s number.
const FALLBACK_STALE_TIME = 30_000;

export function useHoverPrefetch() {
  const queryClient = useQueryClient();
  // Generic over the same params as `prefetchQuery` so a branded
  // `queryOptions()` result (from `@/lib/queryOptions`) flows through without
  // widening `TData` to `unknown` — which would otherwise be rejected by the
  // contravariant `staleTime` position.
  return useCallback(
    <TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
      options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
    ) => {
      const clientDefault = queryClient.getDefaultOptions().queries?.staleTime;
      const staleTime =
        typeof clientDefault === "number" ? clientDefault : FALLBACK_STALE_TIME;
      // `staleTime` first so a factory's own value (should one set it) still wins.
      void queryClient.prefetchQuery({ staleTime, ...options }).catch(() => {});
    },
    [queryClient],
  );
}
