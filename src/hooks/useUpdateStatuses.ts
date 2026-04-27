"use client";

import { useState, useEffect, useRef } from "react";
import type { SkillUpdateStatus } from "@/lib/skillUpdateCache";

interface UpdateStatusResponse {
  statuses: Record<string, SkillUpdateStatus>;
  pending: number;
  total: number;
}

const POLL_INTERVAL = 10_000;

export function useUpdateStatuses() {
  const [statuses, setStatuses] = useState<Record<string, SkillUpdateStatus>>({});
  const [pending, setPending] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch("/api/catalog-updates");
        if (!res.ok || stopped) return;
        const data: UpdateStatusResponse = await res.json();
        setStatuses(data.statuses);
        setPending(data.pending);

        if (data.pending === 0 && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch {
        // Network error, will retry
      }
    }

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      stopped = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { statuses, pending };
}
