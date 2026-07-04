import "server-only";
import {
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";
import { queryClientDefaults } from "@/lib/queryConfig";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";

/**
 * Server-side prefetch + dehydration for the RSC hydration pattern (Performance
 * P3 — PR 3).
 *
 * The read-heavy pages (`/sessions`, `/usage`, …) are async RSCs that, when the
 * `rscHydration` flag is on, prefetch their data into a throwaway server-side
 * `QueryClient`, dehydrate it, and hand the state to `<HydrationBoundary>`. The
 * client `QueryProvider` rehydrates that cache before the page's `useQuery`
 * runs, so the page paints with data instead of a loading spinner and fires no
 * first-mount round-trip.
 *
 * This module owns the three things every page would otherwise duplicate: the
 * flag gate, the per-request server client, and the JSON-clone parity guard.
 */

/** A prefetch step: fill one query into the provided server client. */
export type Prefetcher = (qc: QueryClient) => Promise<unknown>;

/**
 * Build a fresh server-side `QueryClient` for one request.
 *
 * Always a NEW client per call — a server client is per-request scratch space;
 * sharing one across concurrent renders would leak one request's data into
 * another's dehydrated state. Configured from the same isomorphic defaults the
 * browser uses (`queryClientDefaults`) so hydrated data isn't treated as stale
 * the instant the client mounts.
 */
export function makeServerQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryClientDefaults });
}

/**
 * Round-trip a server-computed value through JSON so it is byte-identical to
 * what the client's `fetch(...).then((r) => r.json())` would produce.
 *
 * Without this, the data prefetched server-side is serialized to the client via
 * React Flight, which preserves `Date`/`Map`/`undefined`; but a later
 * client-side refetch goes through `JSON`, which renders `Date`→ISO string and
 * drops `undefined` keys. The two representations of "the same" query would then
 * differ, defeating cache reuse and risking subtle render bugs. Cloning here
 * makes the server prefetch and the client fetch land identical bytes in the
 * cache. Cheap on a local dashboard; correctness is worth it.
 */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Run the given prefetchers and return dehydrated cache state — or `null` when
 * the `rscHydration` flag is off, in which case the page renders its client
 * island unprefetched (today's behavior: fetch-on-mount).
 *
 * Passing `state ?? undefined` to `<HydrationBoundary>` makes the off case a
 * transparent pass-through, so each page is a two-liner regardless of flag.
 */
export async function maybeDehydrate(
  prefetchers: Prefetcher[],
): Promise<DehydratedState | null> {
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "rscHydration")) return null;

  const qc = makeServerQueryClient();
  // prefetchQuery never rejects (it swallows queryFn errors internally), so a
  // single failing prefetch degrades to "client fetches that one on mount"
  // rather than throwing the whole page render.
  await Promise.all(prefetchers.map((p) => p(qc)));
  return dehydrate(qc);
}
