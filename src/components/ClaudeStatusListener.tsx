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
  // Track (incidentId, status, impact, transition) we've already toasted so an
  // overlapping poll/refresh can't fire a duplicate notification. Including
  // impact catches severity escalations (e.g. minor→major while status stays
  // `investigating`); including transition lets a resolve-then-reopen of the
  // same incident still notify.
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

        let maxChangedAt = lastCheckedRef.current;
        for (const change of data) {
          const key = `${change.incidentId}:${change.status}:${change.impact}:${change.transition}`;
          if (!seenRef.current.has(key)) {
            seenRef.current.add(key);
            const { title, body } = describeTransition(change);
            showToast(title, body);
          }
          if (change.changedAt > maxChangedAt) maxChangedAt = change.changedAt;
        }
        // Advance the cursor to the latest server-stamped `changedAt` we
        // observed. Falls back to the previous cursor if the response was
        // empty (preserving since= so the same window is rechecked). This
        // avoids the "client clock ahead of server" skip where setting
        // `Date.now()` would jump past unconsumed transitions.
        lastCheckedRef.current = maxChangedAt;
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
