"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/components/ToastProvider";
import { useLiveEventsEnabled } from "@/components/ConfigProvider";
import { useLiveEvent } from "@/components/LiveEventsProvider";
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
  const liveEvents = useLiveEventsEnabled();
  const lastToastAt = useRef(0);
  // Guards state application against a response that resolves after unmount (or
  // after an effect is torn down) — replaces the old effect-local `stopped`
  // check that the pre-refactor `poll` had before its setState calls.
  const mountedRef = useRef(true);
  const { showToast } = useToast();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch + apply once (no scheduling). Returns the payload so the polling
  // fallback can drive its backoff; errors are toasted (cooldown'd) and
  // swallowed, returning null.
  const fetchStatus = useCallback(async (): Promise<GithubActivityResponse | null> => {
    try {
      const res = await fetch("/api/github-activity");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: GithubActivityResponse = await res.json();
      if (!mountedRef.current) return data;
      setStatuses(data.statuses);
      setPending(data.pending);
      return data;
    } catch {
      const now = Date.now();
      if (now - lastToastAt.current > ERROR_TOAST_COOLDOWN) {
        lastToastAt.current = now;
        showToast("GitHub activity unavailable");
      }
      return null;
    }
  }, [showToast]);

  // SSE path: the github-activity cache pushes an event each time a batch lands,
  // so refetch on push instead of polling. Inert when the flag is off.
  useLiveEvent("github-activity.updated", () => {
    void fetchStatus();
  });

  useEffect(() => {
    let stopped = false;
    let slowed = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let idlePolls = 0;

    function schedule(ms: number) {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(loop, ms);
    }
    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    async function loop() {
      const data = await fetchStatus();
      if (stopped || !data) return;

      if (data.pending > 0) {
        // Work is streaming in — reset the grace and resume fast polling.
        idlePolls = 0;
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
        idlePolls += 1;
        if (idlePolls >= MAX_IDLE_POLLS && !slowed) {
          slowed = true;
          schedule(IDLE_POLL_INTERVAL);
        }
      }
    }

    // When SSE drives refetches, just prime once and let events do the rest.
    if (liveEvents) {
      void fetchStatus();
      return () => {
        stopped = true;
      };
    }

    // Polling fallback (unchanged behavior when the flag is off).
    void loop();
    intervalId = setInterval(loop, POLL_INTERVAL);
    return () => {
      stopped = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [liveEvents, fetchStatus]);

  return { statuses, pending };
}
