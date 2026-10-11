import "server-only";
import { emitAgentEvent, onAgentEvent } from "@/lib/agentView/eventBus";
import type { LiveAgentEvent } from "@/lib/agentView/types";
import { emitMinderEvent, onMinderEvent } from "./bus";
import { isMinderEventType, type MinderEvent } from "./types";

// Both in-process buses — Agent View's and the `/api/events` one — live on
// `globalThis`, which is per-isolate. Inside the ingest worker, ingest's
// post-commit `bridgeJsonlAppendToEventBus` and `emitMinderEvent("sessions.changed")`
// fire on the worker's copies, where no SSE route listens (#657). The worker
// relays its bus traffic with `relayBusEvents`; the host passes each message to
// `reemitRelayedEvent`, which re-emits validated copies on the main thread.
//
// Opt-in from the worker entry rather than built into the buses, so the buses
// stay free of `worker_threads` and of the host's message protocol.

/** A bus event relayed from a worker isolate to the main thread. */
type RelayedEvent =
  | { type: "agent-event"; event: LiveAgentEvent }
  | { type: "minder-event"; event: MinderEvent };

/** Worker side: post every event on this isolate's buses until disposed. */
export function relayBusEvents(post: (message: RelayedEvent) => void): () => void {
  const send = (message: RelayedEvent) => {
    try {
      post(message);
    } catch {
      /* a lost notification must never break the code that emitted the event */
    }
  };
  const offAgent = onAgentEvent((event) => send({ type: "agent-event", event }));
  const offMinder = onMinderEvent((event) => send({ type: "minder-event", event }));
  return () => {
    offAgent();
    offMinder();
  };
}

const AGENT_EVENT_KINDS: ReadonlySet<unknown> = new Set<LiveAgentEvent["kind"]>([
  "hook",
  "jsonl-tail",
  "daemon-change",
]);

const optionalString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Host side: re-emit a relayed message on this thread's buses. Boundary input from another isolate — rebuilt from validated fields, never
 * re-emitted as received.
 */
export function reemitRelayedEvent(message: { type?: unknown; event?: unknown }): void {
  const ev = message.event as Record<string, unknown> | null | undefined;
  if (message.type === "agent-event") {
    if (
      ev && AGENT_EVENT_KINDS.has(ev.kind) &&
      typeof ev.sessionId === "string" && typeof ev.slug === "string"
    ) {
      emitAgentEvent({
        kind: ev.kind as LiveAgentEvent["kind"],
        sessionId: ev.sessionId,
        slug: ev.slug,
        hookEventName: optionalString(ev.hookEventName) as LiveAgentEvent["hookEventName"],
        toolName: optionalString(ev.toolName),
        message: optionalString(ev.message),
      });
    }
  } else if (message.type === "minder-event") {
    const type = ev?.type;
    if (isMinderEventType(type)) emitMinderEvent(type);
  }
}
