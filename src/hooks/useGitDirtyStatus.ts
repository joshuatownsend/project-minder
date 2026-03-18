"use client";

import { useState, useEffect, useRef } from "react";

interface DirtyStatus {
  isDirty: boolean;
  uncommittedCount: number;
  checkedAt: number;
}

interface GitStatusResponse {
  statuses: Record<string, DirtyStatus>;
  pending: number;
  total: number;
}

const POLL_INTERVAL = 5000;

export function useGitDirtyStatus() {
  const [statuses, setStatuses] = useState<Record<string, DirtyStatus>>({});
  const [pending, setPending] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch("/api/git-status");
        if (!res.ok || stopped) return;
        const data: GitStatusResponse = await res.json();
        setStatuses(data.statuses);
        setPending(data.pending);

        // Stop polling once all checks are done
        if (data.pending === 0 && data.total > 0 && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch {
        // Network error, will retry
      }
    }

    // Initial fetch
    poll();

    // Poll while background worker is processing
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      stopped = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { statuses, pending };
}
