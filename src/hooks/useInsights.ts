"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { InsightEntry, InsightsInfo } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";

interface AllInsightsResult {
  insights: InsightEntry[];
  total: number;
}

export function useAllInsights(projectFilter?: string, query?: string) {
  const result = useQuery({
    queryKey: queryKeys.insights.all(projectFilter, query),
    queryFn: async ({ signal }): Promise<AllInsightsResult> => {
      const params = new URLSearchParams();
      if (projectFilter) params.set("project", projectFilter);
      if (query) params.set("q", query);
      const qs = params.toString();
      const res = await fetch(`/api/insights${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error(`Failed to load insights: ${res.status}`);
      return res.json();
    },
  });

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    data: result.data ?? { insights: [], total: 0 },
    loading: result.isPending,
    refresh,
  };
}

export function useProjectInsights(slug: string) {
  const result = useQuery({
    queryKey: queryKeys.insights.detail(slug),
    queryFn: async ({ signal }): Promise<InsightsInfo | null> => {
      const res = await fetch(`/api/insights/${slug}`, { signal });
      return res.ok ? res.json() : null;
    },
    enabled: slug.length > 0,
  });

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: result.data ?? null, loading: result.isPending, refresh };
}
