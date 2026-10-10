"use client";

import { useQuery } from "@tanstack/react-query";
import { usageQuery } from "@/lib/queryOptions";

export function useUsage(period: string, project?: string, home?: string, dirName?: string) {
  const query = useQuery(usageQuery(period, project, home, dirName));
  return { data: query.data ?? null, loading: query.isPending };
}
