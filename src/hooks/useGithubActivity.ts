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

/**
 * Polls GET /api/github-activity (mirrors useGitDirtyStatus): every 5s while
 * the background gh worker is processing, stopping once all checks have
 * settled. The error toast is cooldown'd so a `gh`-less machine never spams.
 */
export function useGithubActivity() {
  const [statuses, setStatuses] = useState<Record<string, GithubActivity>>({});
  const [pending, setPending] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastToastAt = useRef(0);
  const { showToast } = useToast();

  useEffect(() => {
    let stopped = false;

    async function poll() {
      try {
        const res = await fetch("/api/github-activity");
        if (stopped) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: GithubActivityResponse = await res.json();
        setStatuses(data.statuses);
        setPending(data.pending);

        // Stop polling once all checks are done.
        if (data.pending === 0 && data.total > 0 && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
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
