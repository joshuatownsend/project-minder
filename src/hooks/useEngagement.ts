"use client";

import { useQuery } from "@tanstack/react-query";
import { engagementQuery } from "@/lib/queryOptions";

export function useEngagement(
  period: string,
  project: string | undefined,
  responseMinutes: number,
  runCapMinutes: number,
  tailMinutes: number,
) {
  const query = useQuery({
    ...engagementQuery(period, project, responseMinutes, runCapMinutes, tailMinutes),
    // Keep the previous report on screen while a slider drag refetches, so
    // the numbers move rather than flashing through an empty skeleton.
    placeholderData: (prev) => prev,
    retry: false,
  });
  return {
    data: query.data ?? null,
    loading: query.isPending,
    fetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
  };
}
