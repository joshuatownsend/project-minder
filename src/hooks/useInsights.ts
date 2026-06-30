"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { insightsListQuery, insightDetailQuery } from "@/lib/queryOptions";

export function useAllInsights(projectFilter?: string, query?: string) {
  const result = useQuery(insightsListQuery(projectFilter, query));

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
    ...insightDetailQuery(slug),
    enabled: slug.length > 0,
  });

  const { refetch } = result;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: result.data ?? null, loading: result.isPending, refresh };
}
