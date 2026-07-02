"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveEventsEnabled } from "@/components/ConfigProvider";
import { MINDER_EVENT_TYPES } from "@/lib/events/types";
import { eventToQueryPrefixes } from "@/lib/events/invalidation";

/**
 * Opens the single `/api/events` SSE stream (when the `liveEvents` flag is on)
 * and invalidates the mapped TanStack Query keys on each pushed event, so pages
 * refresh in real time instead of polling (Performance P3 — PR 5a).
 *
 * Renders nothing; mounted once inside `QueryProvider` (for `useQueryClient`)
 * and `ConfigProvider` (for the flag). When the flag is off the effect is inert
 * and no connection is opened — behaviour is byte-identical to before.
 */
export function LiveEventsBridge() {
  const enabled = useLiveEventsEnabled();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const source = new EventSource("/api/events");
    const listeners = MINDER_EVENT_TYPES.map((type) => {
      const handler = () => {
        for (const queryKey of eventToQueryPrefixes(type)) {
          queryClient.invalidateQueries({ queryKey });
        }
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

  return null;
}
