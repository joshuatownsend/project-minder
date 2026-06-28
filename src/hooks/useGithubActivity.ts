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
const ERROR_TOAST_COOLDOWN = 60_000;
// Consecutive idle polls (pending===0 AND total===0) tolerated before we give
// up. Unlike git-status, GitHub activity may legitimately have nothing to wait
// for — the feature flag is off, or no project has a GitHub remote — in which
// case the queue never fills. Stopping on the very first idle poll would race
// the enqueue (GET /api/projects populates the queue a moment after this hook's
// first fetch), so we allow a short grace (~3 polls = ~15s) for work to appear.
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
          // Work is streaming in — keep polling and reset the idle grace.
          idlePolls.current = 0;
        } else if (data.total > 0) {
          // All enqueued checks have settled — nothing left to wait for.
          stopPolling();
        } else {
          // Nothing enqueued (flag off / no GitHub repos / pre-enqueue race).
          // Give the enqueue a few polls to land, then stop polling forever.
          idlePolls.current += 1;
          if (idlePolls.current >= MAX_IDLE_POLLS) stopPolling();
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
