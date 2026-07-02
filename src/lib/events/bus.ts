import "server-only";
import { EventEmitter } from "events";
import type { MinderEvent, MinderEventType } from "./types";

/**
 * In-process pub/sub for cross-cutting "data changed" signals (Performance P3 —
 * PR 5a), consumed by the `/api/events` SSE route which forwards them to
 * connected browsers so the client can `invalidateQueries` instead of polling.
 *
 * Mirrors `@/lib/agentView/eventBus`: a single `EventEmitter` pinned on
 * `globalThis` so dev HMR reuses one instance and SSE handlers that subscribed
 * before a reload keep their listeners. Every SSE handler MUST unsubscribe via
 * the returned disposer (driven by the request AbortSignal) so dead listeners
 * don't accumulate across reconnects.
 */

const g = globalThis as unknown as {
  __minderEventBus?: EventEmitter;
};

function getBus(): EventEmitter {
  if (!g.__minderEventBus) {
    const bus = new EventEmitter();
    // Dev HMR + multiple browser tabs each open one SSE listener; 50 is well
    // above any load a single-user local dashboard produces.
    bus.setMaxListeners(50);
    g.__minderEventBus = bus;
  }
  return g.__minderEventBus;
}

const EVENT = "minder:event" as const;

/**
 * Broadcast that a class of data changed. Fire-and-forget and cheap when no SSE
 * client is connected (no listeners → `emit` is a no-op), so it's safe to call
 * from hot server paths (cache invalidation, the ingest loop, file watchers).
 */
export function emitMinderEvent(type: MinderEventType): void {
  getBus().emit(EVENT, { type } satisfies MinderEvent);
}

/** Subscribe to every event; returns a disposer that removes the listener. */
export function onMinderEvent(listener: (ev: MinderEvent) => void): () => void {
  const bus = getBus();
  bus.on(EVENT, listener);
  return () => bus.off(EVENT, listener);
}
