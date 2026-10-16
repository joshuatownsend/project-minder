"use client";

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessionsQuery, sessionDetailQuery } from "@/lib/queryOptions";
import { useLiveEventsEnabled } from "@/components/ConfigProvider";
import type { SessionSummary } from "@/lib/types";

// One shared empty list, so `data` keeps its identity while nothing has loaded.
// A fresh `[]` per render re-fires every effect keyed on `data` (the Sessions
// page's search effect is one) on every render (Copilot, PR #705).
const NO_SESSIONS: SessionSummary[] = [];

export function useAllSessions() {
  const liveEvents = useLiveEventsEnabled();
  const query = useQuery({
    ...sessionsQuery(),
    // When the SSE stream is on, `sessions.changed` events invalidate this
    // query, so the 15s timer is redundant — drop it. Off (default): keep the
    // prior 15s live-refresh; TanStack pauses the interval while the tab is
    // hidden (refetchIntervalInBackground=false).
    refetchInterval: liveEvents ? false : 15_000,
  });

  const { refetch } = query;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return { data: query.data ?? NO_SESSIONS, loading: query.isPending, refresh };
}

export function useSessionDetail(sessionId: string) {
  const query = useQuery({
    ...sessionDetailQuery(sessionId),
    enabled: sessionId.length > 0,
  });

  return { data: query.data ?? null, loading: query.isPending };
}
