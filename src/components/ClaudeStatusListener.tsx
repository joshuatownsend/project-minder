"use client";

/**
 * ClaudeStatusListener — polls `/api/claude-status/changes?since=…` every
 * 60s and surfaces transitions as toasts.
 *
 * Lives alongside `NotificationListener` and uses the same `useToast()`
 * hook. The cursor (`lastChecked`) advances to the polling timestamp on
 * each successful pull, mirroring the pattern in `PulseProvider`.
 *
 * Renders nothing — purely side-effectful.
 */

import { useEffect, useRef } from "react";
import { useToast } from "./ToastProvider";
import type { ClaudeStatusChange } from "@/lib/claudeStatus/types";

const POLL_INTERVAL_MS = 60_000;

function describeTransition(c: ClaudeStatusChange): { title: string; body: string } {
  if (c.transition === "new") {
    return {
      title: `Claude incident: ${c.name}`,
      body: `${c.impact.toUpperCase()} impact — ${c.status}`,
    };
  }
  if (c.transition === "resolved") {
    return { title: `Claude incident resolved`, body: c.name };
  }
  return {
    title: `Claude incident updated`,
    body: `${c.name} — now ${c.status} (${c.impact} impact)`,
  };
}

export function ClaudeStatusListener() {
  const { showToast } = useToast();
  const lastCheckedRef = useRef<string>(new Date().toISOString());
  // Track (incidentId, status) we've already toasted so an overlapping
  // poll/refresh can't fire a duplicate notification.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function pull() {
      try {
        const url = `/api/claude-status/changes?since=${encodeURIComponent(lastCheckedRef.current)}`;
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as ClaudeStatusChange[] | { error?: string };
        if (cancelled) return;
        if (!Array.isArray(data)) return;

        for (const change of data) {
          const key = `${change.incidentId}:${change.status}`;
          if (seenRef.current.has(key)) continue;
          seenRef.current.add(key);
          const { title, body } = describeTransition(change);
          showToast(title, body);
        }
        // Advance the cursor to "just now" so the next poll only fetches
        // events newer than this call. We deliberately don't use the
        // server-supplied timestamp on each change because we want a
        // single monotonic cursor; `getChanges(since)` is filter-only,
        // so over-fetching is the worst that can happen on clock skew.
        lastCheckedRef.current = new Date().toISOString();
      } catch {
        // Transient errors are non-fatal — try again next tick.
      }
    }

    pull();
    const id = setInterval(pull, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [showToast]);

  return null;
}
