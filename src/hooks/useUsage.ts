"use client";

import { useQuery } from "@tanstack/react-query";
import { UsageReport } from "@/lib/usage/types";
import { queryKeys } from "@/lib/queryKeys";

export function useUsage(period: string, project?: string) {
  const query = useQuery({
    queryKey: queryKeys.usage(period, project),
    queryFn: async ({ signal }): Promise<UsageReport> => {
      const params = new URLSearchParams({ period });
      if (project) params.set("project", project);
      const res = await fetch(`/api/usage?${params}`, { signal });
      if (!res.ok) throw new Error(`Failed to load usage: ${res.status}`);
      return res.json();
    },
  });

  return { data: query.data ?? null, loading: query.isPending };
}
