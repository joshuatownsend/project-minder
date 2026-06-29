"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessionsQuery, sessionDetailQuery } from "@/lib/queryOptions";

export function useAllSessions() {
  const query = useQuery({
    ...sessionsQuery(),
    // Preserve the prior 15s live-refresh; TanStack pauses the interval
    // automatically while the tab is hidden (refetchIntervalInBackground=false).
    refetchInterval: 15_000,
  });

  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: query.data ?? [], loading: query.isPending, refresh };
}

export function useSessionDetail(sessionId: string) {
  const query = useQuery({
    ...sessionDetailQuery(sessionId),
    enabled: sessionId.length > 0,
  });

  return { data: query.data ?? null, loading: query.isPending };
}
