"use client";

import { useQuery } from "@tanstack/react-query";
import { statsQuery } from "@/lib/queryOptions";

export function useStats() {
  const query = useQuery(statsQuery());
  return { data: query.data ?? null, loading: query.isPending };
}
