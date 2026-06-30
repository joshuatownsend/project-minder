"use client";

import { useQuery } from "@tanstack/react-query";
import { usageQuery } from "@/lib/queryOptions";

export function useUsage(period: string, project?: string) {
  const query = useQuery(usageQuery(period, project));
  return { data: query.data ?? null, loading: query.isPending };
}
