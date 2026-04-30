"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const POLL_INTERVAL_MS = 5_000;

export interface PulseChange {
  slug: string;
  projectName: string;
  title: string;
  changedAt: string;
}

export interface PulseSnapshot {
  pendingSteps: number;
  approvalCount: number;
  generatedAt: string | null;
}

type ChangeListener = (changes: PulseChange[]) => void;

interface PulseContextValue {
  snapshot: PulseSnapshot;
  // Subscribe to fresh `changes` arrays as they arrive from each pulse hit.
  // Returns an unsubscribe fn. Each subscriber is called with the same array
  // from each poll, so consumers should treat the array as ephemeral and dedupe
  // themselves if they care about idempotency across re-mounts.
  subscribeChanges: (listener: ChangeListener) => () => void;
}

const PulseContext = createContext<PulseContextValue | null>(null);

export function PulseProvider({ children }: { children: ReactNode }) {
  // Counts re-render the badges on every change; changes are pushed via a
  // listener registry instead so the toast/notification path doesn't trigger a
  // re-render of the whole tree just to say "no new events this tick."
  const [snapshot, setSnapshot] = useState<PulseSnapshot>({
    pendingSteps: 0,
    approvalCount: 0,
    generatedAt: null,
  });
  const lastCheckedRef = useRef<string>(new Date().toISOString());
  const listenersRef = useRef<Set<ChangeListener>>(new Set());
  const inFlightRef = useRef(false);

  const subscribeChanges = useCallback((listener: ChangeListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // Snapshot the cursor BEFORE the fetch so we can advance it only on
      // success. If the fetch fails, the next poll re-uses the same `since`
      // and any change events that arrived in the gap are still delivered
      // exactly once. The server returns `generatedAt` which is the canonical
      // "next cursor" — using it (instead of "now") avoids skipping events
      // generated between request-send and response-arrival.
      const since = lastCheckedRef.current;
      try {
        const res = await fetch(`/api/pulse?since=${encodeURIComponent(since)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          pendingSteps: number;
          approvalCount: number;
          changes: PulseChange[];
          generatedAt: string;
        };

        lastCheckedRef.current = data.generatedAt;

        setSnapshot({
          pendingSteps: data.pendingSteps,
          approvalCount: data.approvalCount,
          generatedAt: data.generatedAt,
        });

        if (data.changes && data.changes.length > 0) {
          for (const listener of listenersRef.current) {
            try {
              listener(data.changes);
            } catch {
              // a misbehaving listener shouldn't kill the pulse loop
            }
          }
        }
      } catch {
        // Network blip — we'll retry next interval. Don't throw, don't clear
        // the snapshot (last-known-good values keep rendering), and don't
        // advance lastCheckedRef so the missed changes get redelivered.
      } finally {
        inFlightRef.current = false;
      }
    }

    // Hidden-tab pause: we still respond to visibility changes so the snapshot
    // refreshes immediately when the user comes back, instead of waiting up to
    // 5 seconds for the next interval tick.
    function tick() {
      if (typeof document !== "undefined" && document.hidden) return;
      void poll();
    }

    function handleVisibility() {
      if (typeof document !== "undefined" && !document.hidden) {
        void poll();
      }
    }

    void poll(); // prime the snapshot on mount
    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, []);

  return (
    <PulseContext.Provider value={{ snapshot, subscribeChanges }}>
      {children}
    </PulseContext.Provider>
  );
}

export function usePulse(): PulseContextValue {
  const ctx = useContext(PulseContext);
  if (!ctx) {
    throw new Error("usePulse must be used inside <PulseProvider>");
  }
  return ctx;
}
