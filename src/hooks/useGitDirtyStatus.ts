"use client";

import { useState, useEffect, useRef } from "react";
import { useToast } from "@/components/ToastProvider";

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
const ERROR_TOAST_COOLDOWN = 60_000;
// Consecutive idle polls (pending===0 AND total===0) tolerated before giving up.
// Normally git projects always enqueue (total becomes >0), but a scope with zero
// git-tracked projects would otherwise poll forever; a short grace also absorbs
// the enqueue race (GET /api/projects fills the queue just after the first poll).
const MAX_IDLE_POLLS = 3;

export function useGitDirtyStatus() {
  const [statuses, setStatuses] = useState<Record<string, DirtyStatus>>({});
  const [pending, setPending] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idlePolls = useRef(0);
  const lastToastAt = useRef(0);
  const { showToast } = useToast();

  useEffect(() => {
    let stopped = false;

    function stopPolling() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    async function poll() {
      try {
        const res = await fetch("/api/git-status");
        if (stopped) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: GitStatusResponse = await res.json();
        setStatuses(data.statuses);
        setPending(data.pending);

        if (data.pending > 0) {
          // Work is streaming in — keep polling and reset the idle grace.
          idlePolls.current = 0;
        } else if (data.total > 0) {
          // All enqueued checks have settled — nothing left to wait for.
          stopPolling();
        } else {
          // Nothing enqueued yet — give the enqueue a few polls to land,
          // then stop instead of polling forever (flag off / no git repos).
          idlePolls.current += 1;
          if (idlePolls.current >= MAX_IDLE_POLLS) stopPolling();
        }
      } catch {
        if (!stopped) {
          const now = Date.now();
          if (now - lastToastAt.current > ERROR_TOAST_COOLDOWN) {
            lastToastAt.current = now;
            showToast("Git status unavailable");
          }
        }
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
  }, [showToast]);

  return { statuses, pending };
}
