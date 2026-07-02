"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveEventsEnabled } from "@/components/ConfigProvider";
import { MINDER_EVENT_TYPES, type MinderEventType } from "@/lib/events/types";
import { eventToQueryPrefixes } from "@/lib/events/invalidation";

/**
 * Opens the single `/api/events` SSE stream (when the `liveEvents` flag is on)
 * and, for each pushed event, does two things (Performance P3 — PR 5):
 *   1. invalidates the mapped TanStack Query keys (PR 5a), and
 *   2. fans the event out to non-Query subscribers registered via
 *      `useLiveEvent` — the bespoke git/github/pulse pollers, which can't be
 *      driven by `invalidateQueries` (PR 5b).
 *
 * One connection for the whole app. Mounted once inside `QueryProvider` (for
 * `useQueryClient`) and `ConfigProvider` (for the flag); when the flag is off
 * the effect is inert and no connection is opened — behaviour is byte-identical
 * to before.
 */

type Subscribe = (type: MinderEventType, handler: () => void) => () => void;

const LiveEventsContext = createContext<Subscribe>(() => () => {});

export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const enabled = useLiveEventsEnabled();
  const queryClient = useQueryClient();
  // type → set of non-Query subscriber callbacks. A ref (not state) so
  // (un)subscribing never re-renders the tree or re-opens the stream.
  const subscribersRef = useRef<Map<MinderEventType, Set<() => void>>>(new Map());

  const subscribe = useCallback<Subscribe>((type, handler) => {
    let set = subscribersRef.current.get(type);
    if (!set) {
      set = new Set();
      subscribersRef.current.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource("/api/events");
    const listeners = MINDER_EVENT_TYPES.map((type) => {
      const handler = () => {
        for (const queryKey of eventToQueryPrefixes(type)) {
          queryClient.invalidateQueries({ queryKey });
        }
        const set = subscribersRef.current.get(type);
        if (set) for (const h of set) h();
      };
      source.addEventListener(type, handler);
      return { type, handler };
    });

    return () => {
      for (const { type, handler } of listeners) {
        source.removeEventListener(type, handler);
      }
      source.close();
    };
  }, [enabled, queryClient]);

  return <LiveEventsContext.Provider value={subscribe}>{children}</LiveEventsContext.Provider>;
}

/**
 * Subscribe a non-Query consumer (e.g. a bespoke poller) to a live event so it
 * can refetch on push instead of on a timer. Inert unless the `liveEvents` flag
 * is on. The handler is invoked through a ref, so passing an inline arrow does
 * not churn the subscription.
 */
export function useLiveEvent(type: MinderEventType, handler: () => void): void {
  const subscribe = useContext(LiveEventsContext);
  const enabled = useLiveEventsEnabled();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    return subscribe(type, () => handlerRef.current());
  }, [subscribe, type, enabled]);
}
