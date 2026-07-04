"use client";

/**
 * ClaudeStatusProvider — the single source of truth for Claude service status
 * on the dashboard (C2b consolidation).
 *
 * Before this, two global components each ran their own 60s poll:
 *   - `ClaudeStatusBanner` polled `/api/claude-status` for the snapshot.
 *   - `ClaudeStatusListener` polled `/api/claude-status/changes` for toasts.
 *
 * They're now one `useQuery` against the combined `/api/claude-status/live`
 * endpoint: one 60s request that yields both the snapshot (exposed via context
 * to the banner) and the change events (turned into toasts here, preserving the
 * listener's cursor + dedupe behavior). `refetchIntervalInBackground: false`
 * also pauses the poll on a hidden tab — a behavior neither old poller had.
 */

import { createContext, useContext, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "./ToastProvider";
import { queryKeys } from "@/lib/queryKeys";
import type { ClaudeStatusSnapshot, ClaudeStatusChange } from "@/lib/claudeStatus/types";

const POLL_INTERVAL_MS = 60_000;

interface LivePayload {
  disabled?: boolean;
  snapshot: ClaudeStatusSnapshot | null;
  changes: ClaudeStatusChange[];
}

interface ClaudeStatusContextValue {
  snapshot: ClaudeStatusSnapshot | null;
  disabled: boolean;
}

const ClaudeStatusContext = createContext<ClaudeStatusContextValue>({
  snapshot: null,
  disabled: false,
});

/** Read the shared claude-status snapshot (used by ClaudeStatusBanner). */
export function useClaudeStatus(): ClaudeStatusContextValue {
  return useContext(ClaudeStatusContext);
}

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

export function ClaudeStatusProvider({ children }: { children: ReactNode }) {
  const { showToast } = useToast();
  // Cursor advances to the latest server-stamped `changedAt` we've observed.
  // Read from a ref (not the query key) so the query key stays stable and the
  // 60s refetch just picks up the current cursor. Mirrors the old listener.
  const lastCheckedRef = useRef<string>(new Date().toISOString());
  // Track (incidentId, status, impact, transition) already toasted so an
  // overlapping poll can't fire a duplicate notification.
  const seenRef = useRef<Set<string>>(new Set());

  const query = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: async ({ signal }): Promise<LivePayload> => {
      const url = `/api/claude-status/live?since=${encodeURIComponent(lastCheckedRef.current)}`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LivePayload;

      // Surface unseen transitions as toasts and advance the cursor to the
      // latest observed `changedAt` (falls back to the prior cursor on an empty
      // window, so the same range is rechecked — no "client clock ahead" skip).
      if (Array.isArray(data.changes)) {
        let maxChangedAt = lastCheckedRef.current;
        for (const change of data.changes) {
          const key = `${change.incidentId}:${change.status}:${change.impact}:${change.transition}`;
          if (!seenRef.current.has(key)) {
            seenRef.current.add(key);
            const { title, body } = describeTransition(change);
            showToast(title, body);
          }
          if (change.changedAt > maxChangedAt) maxChangedAt = change.changedAt;
        }
        lastCheckedRef.current = maxChangedAt;
      }

      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const value: ClaudeStatusContextValue = {
    // TanStack retains the last good `data` across a transient refetch error,
    // so the banner keeps showing the last known snapshot instead of flashing.
    snapshot: query.data?.snapshot ?? null,
    disabled: query.data?.disabled ?? false,
  };

  return (
    <ClaudeStatusContext.Provider value={value}>
      {children}
    </ClaudeStatusContext.Provider>
  );
}
