"use client";

import { useQuery } from "@tanstack/react-query";
import { StatsData } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";

export function useStats() {
  const query = useQuery({
    queryKey: queryKeys.stats(),
    queryFn: async ({ signal }): Promise<StatsData> => {
      const res = await fetch("/api/stats", { signal });
      if (!res.ok) throw new Error(`Failed to load stats: ${res.status}`);
      return res.json();
    },
  });

  return { data: query.data ?? null, loading: query.isPending };
}
