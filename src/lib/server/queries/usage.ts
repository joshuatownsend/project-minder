import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { getUsage } from "@/lib/data";
import { validatePeriod } from "@/lib/usage/constants";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Prefetch the usage report for the dashboard's default view.
 *
 * `UsageDashboard` mounts with `period="30d"`, `project=undefined`, and its
 * secondary `useUsage(period)` collapses to the same cache key when project is
 * undefined — so this one prefetch (`["usage","30d",null]`) satisfies the
 * initial render. No route refactor is needed: `/api/usage` returns
 * `getUsage(period).report` directly, so the façade is already the single
 * source of truth for the body. We JSON-clone the report so it matches the
 * route's JSON serialization exactly.
 */
const DEFAULT_PERIOD = "30d";

export async function prefetchUsage(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.usage(DEFAULT_PERIOD),
    queryFn: async () => {
      const { report } = await getUsage(validatePeriod(DEFAULT_PERIOD));
      return jsonClone(report);
    },
  });
}
