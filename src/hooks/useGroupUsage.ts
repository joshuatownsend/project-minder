"use client";

import { useQueries } from "@tanstack/react-query";
import { usageQuery } from "@/lib/queryOptions";
import { sumUsageReports, type GroupUsageSummary } from "@/lib/groups/usageSum";
import type { UsageKey } from "@/lib/groups/aggregate";
import type { UsageReport } from "@/lib/usage/types";

export interface GroupUsageKeyResult {
  key: UsageKey;
  report: UsageReport | null;
  loading: boolean;
  error: boolean;
}

/**
 * Usage for a project group: one `/api/usage` query per deduplicated usage
 * key, summed in this layer. Never per member — two local drives that share
 * a `usageSlug` are one key, and fetching per member would double-count them
 * (that dedupe is `groupUsageKeys()` in the aggregate layer).
 *
 * Each per-key query is the same `usageQuery` the member's own Costs tab
 * runs, so the group page warms the cache the member page reads.
 */
export function useGroupUsage(period: string, usageKeys: readonly UsageKey[]) {
  const results = useQueries({
    queries: usageKeys.map((k) => usageQuery(period, k.usageSlug, k.usageHomeKey)),
  });
  const perKey: GroupUsageKeyResult[] = usageKeys.map((key, i) => ({
    key,
    report: results[i]?.data ?? null,
    loading: results[i]?.isPending ?? false,
    error: results[i]?.isError ?? false,
  }));
  const reports = perKey.map((r) => r.report).filter((r): r is UsageReport => r !== null);
  const summary: GroupUsageSummary = sumUsageReports(reports);
  return {
    perKey,
    summary,
    /** True until every key has answered (or failed). */
    loading: perKey.some((r) => r.loading),
    /** Some keys failed; `summary` covers only the ones that answered. */
    incomplete: perKey.some((r) => r.error),
  };
}
