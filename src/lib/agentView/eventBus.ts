import "server-only";
import { EventEmitter } from "events";
import type { LiveAgentEvent } from "./types";
import type { HookEventName } from "@/lib/types";

// Singleton EventEmitter on globalThis — same pattern as hooks/buffer.ts.
// HMR in dev reloads this module but reuses the same emitter instance so
// SSE route handlers that subscribed before the reload don't lose their
// listeners. Each SSE handler must clean up via the AbortSignal so dead
// listeners don't accumulate.

const g = globalThis as unknown as {
  __minderAgentViewBus?: EventEmitter;
};

function getBus(): EventEmitter {
  if (!g.__minderAgentViewBus) {
    const bus = new EventEmitter();
    // Raise the cap: dev HMR + multiple browser tabs can produce many
    // concurrent SSE listeners. 50 is well above any expected load for a
    // single-user local dashboard.
    bus.setMaxListeners(50);
    g.__minderAgentViewBus = bus;
  }
  return g.__minderAgentViewBus;
}

export const EVENT = "live:agent" as const;

export function emitAgentEvent(event: LiveAgentEvent): void {
  getBus().emit(EVENT, event);
}

export function onAgentEvent(listener: (ev: LiveAgentEvent) => void): () => void {
  const bus = getBus();
  bus.on(EVENT, listener);
  return () => bus.off(EVENT, listener);
}

/** Called from hooks/route.ts after pushHookEvent / updateLiveSession. */
export function bridgeHookToEventBus(
  slug: string,
  sessionId: string,
  hookEventName: HookEventName,
  toolName?: string,
  message?: string,
): void {
  emitAgentEvent({ kind: "hook", sessionId, slug, hookEventName, toolName, message });
}

/**
 * Called from db/ingest.ts after a successful reconcileSessionFile.
 * Emits a minimal event — no JSONL re-read on the hot ingest path.
 */
export function bridgeJsonlAppendToEventBus(sessionId: string, slug: string): void {
  emitAgentEvent({ kind: "jsonl-tail", sessionId, slug });
}

/** Called from jobRoster.ts when daemon state changes. */
export function bridgeDaemonChangeToEventBus(sessionId: string, slug: string): void {
  emitAgentEvent({ kind: "daemon-change", sessionId, slug });
}
