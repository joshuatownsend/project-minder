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
const IDLE_POLL_INTERVAL = 30_000;
const ERROR_TOAST_COOLDOWN = 60_000;
// After this many consecutive idle polls (pending===0 AND total===0) we BACK OFF
// to a slow heartbeat instead of stopping. On a cold load /api/projects only
// enqueues git checks AFTER its scan finishes, which can outlast a hard stop and
// leave dirty status unobserved until remount. Slowing (not stopping) keeps a
// late enqueue visible while avoiding a tight perpetual 5s loop when nothing is
// ever enqueued (flag off / no git-tracked projects).
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
    let slowed = false;

    function schedule(ms: number) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(poll, ms);
    }
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
          // Work is streaming in — reset the grace and resume fast polling.
          idlePolls.current = 0;
          if (slowed) {
            slowed = false;
            schedule(POLL_INTERVAL);
          }
        } else if (data.total > 0) {
          // All enqueued checks have settled — nothing left to wait for.
          stopPolling();
        } else {
          // Nothing enqueued yet (cold scan still running, flag off, or no git
          // repos). Back off to a slow heartbeat after the grace instead of
          // stopping, so a late enqueue from a slow scan is still observed.
          idlePolls.current += 1;
          if (idlePolls.current >= MAX_IDLE_POLLS && !slowed) {
            slowed = true;
            schedule(IDLE_POLL_INTERVAL);
          }
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
