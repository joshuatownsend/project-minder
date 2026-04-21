"use client";

import { useState, useEffect, useCallback } from "react";
import type { SessionStatus, SessionSummary } from "@/lib/types";

export interface LiveSessionStatus {
  status: SessionStatus;
  sessionId: string;
}

/**
 * Polls /api/sessions every 15s and returns the most-recent session status
 * per projectPath, keyed by projectPath.
 *
 * Used by the dashboard to overlay live status onto ProjectCards without
 * triggering a full 5-min-TTL project rescan.
 */
export function useLiveSessionStatus(): Map<string, LiveSessionStatus> {
  const [statusMap, setStatusMap] = useState<Map<string, LiveSessionStatus>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) return;
      const sessions: SessionSummary[] = await res.json();

      // Build map: projectPath → most-recent session (already sorted by endTime desc from API)
      const map = new Map<string, LiveSessionStatus>();
      for (const s of sessions) {
        if (!map.has(s.projectPath) && s.status !== "idle") {
          map.set(s.projectPath, { status: s.status, sessionId: s.sessionId });
        }
      }
      setStatusMap(map);
    } catch {
      // Non-critical — dashboard still works without live status overlay
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") {
        refresh();
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  return statusMap;
}
