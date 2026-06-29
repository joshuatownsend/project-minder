"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { SessionSummary, SessionDetail } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";

export function useAllSessions() {
  const query = useQuery({
    queryKey: queryKeys.sessions.all(),
    queryFn: async ({ signal }): Promise<SessionSummary[]> => {
      const res = await fetch("/api/sessions", { signal });
      if (!res.ok) throw new Error(`Failed to load sessions: ${res.status}`);
      return res.json();
    },
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
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: async ({ signal }): Promise<SessionDetail | null> => {
      const res = await fetch(`/api/sessions/${sessionId}`, { signal });
      return res.ok ? res.json() : null;
    },
    enabled: sessionId.length > 0,
  });

  return { data: query.data ?? null, loading: query.isPending };
}
