"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { KanbanSnapshot, KanbanPeriod } from "@/lib/kanban/types";

const POLL_MS = 6_000; // aligned to getLiveStatusPayload()'s 6 s cache TTL

function emptySnapshot(): KanbanSnapshot {
  return {
    columns: { working: [], waiting: [], idle: [], done: [], error: [] },
    generatedAt: "",
    dispatcherEnabled: true,
  };
}

export function useKanban(period: KanbanPeriod = "last24h") {
  const [snapshot, setSnapshot] = useState<KanbanSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const lastGeneratedAt = useRef<string>("");

  const fetch_ = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/kanban?period=${period}`);
      if (!res.ok) {
        setError(`Fetch failed: ${res.status}`);
        return;
      }
      const data: KanbanSnapshot = await res.json();
      // Short-circuit re-renders when snapshot hasn't changed
      if (data.generatedAt === lastGeneratedAt.current) return;
      lastGeneratedAt.current = data.generatedAt;
      setSnapshot(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetch_();

    const onVisibility = () => {
      if (document.visibilityState === "visible") fetch_();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") fetch_();
    }, POLL_MS);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetch_]);

  return { snapshot, loading, error, refresh: fetch_ };
}
