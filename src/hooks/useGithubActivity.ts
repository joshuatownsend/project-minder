"use client";

import { useState, useEffect, useRef } from "react";
import { useToast } from "@/components/ToastProvider";
import type { GithubActivity } from "@/lib/types";

interface GithubActivityResponse {
  statuses: Record<string, GithubActivity>;
  pending: number;
  total: number;
}

const POLL_INTERVAL = 5000;
const IDLE_POLL_INTERVAL = 30_000;
const ERROR_TOAST_COOLDOWN = 60_000;
// After this many consecutive idle polls (pending===0 AND total===0) we BACK OFF
// to a slow heartbeat instead of stopping. GitHub activity may legitimately have
// nothing to wait for (flag off, or no project has a GitHub remote), but on a
// cold load /api/projects only enqueues AFTER its scan finishes — which can
// outlast a hard stop and leave the strip empty until remount. Slowing (not
// stopping) keeps a late enqueue visible while avoiding a tight perpetual loop.
const MAX_IDLE_POLLS = 3;

/**
 * Polls GET /api/github-activity (mirrors useGitDirtyStatus): every 5s while
 * the background gh worker is processing, stopping once all checks have settled
 * OR once it's clear nothing was ever enqueued. The error toast is cooldown'd
 * so a `gh`-less machine never spams.
 */
export function useGithubActivity() {
  const [statuses, setStatuses] = useState<Record<string, GithubActivity>>({});
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
        const res = await fetch("/api/github-activity");
        if (stopped) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: GithubActivityResponse = await res.json();
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
          // Nothing enqueued yet (cold scan still running, flag off, or no
          // GitHub repos). Back off to a slow heartbeat after the grace instead
          // of stopping, so a late enqueue from a slow scan is still observed.
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
            showToast("GitHub activity unavailable");
          }
        }
      }
    }

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL);

    return () => {
      stopped = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [showToast]);

  return { statuses, pending };
}
