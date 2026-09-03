"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import type { EnvironmentsPayload } from "@/lib/environments/diff";

/** Per-home inventory from `GET /api/environments` (2-min server cache). */
export function useEnvironments(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.environments(),
    enabled,
    queryFn: async ({ signal }): Promise<EnvironmentsPayload> => {
      const res = await fetch("/api/environments", { signal });
      if (!res.ok) throw new Error(`Failed to load environments: ${res.status}`);
      return res.json();
    },
  });
  return { data: query.data ?? null, loading: query.isPending, error: query.isError };
}
