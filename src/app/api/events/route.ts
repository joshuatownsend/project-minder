import { NextRequest } from "next/server";
import { onMinderEvent } from "@/lib/events/bus";
import type { MinderEventType } from "@/lib/events/types";

// Unified SSE stream for live cache invalidation (Performance P3 — PR 5a).
//
// Forwards coarse "data changed" events from the in-process bus to the browser
// as named SSE events; the client (`LiveEventsBridge`) maps each to the
// TanStack Query keys to invalidate. One stream replaces per-resource polling.
//
// Modeled on `api/agent-view/stream`: a ReadableStream that subscribes to the
// globalThis emitter, heartbeats to defeat proxy timeouts, and cleans up via
// request.signal on disconnect. Per-type coalescing collapses bursts (e.g. a
// startup ingest sweep emitting `sessions.changed` per file) into one event.

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 250;

function encode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function comment(text: string): Uint8Array {
  return new TextEncoder().encode(`:${text}\n\n`);
}

export async function GET(request: NextRequest): Promise<Response> {
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // One pending flush timer per event type — collapses a burst of the same
      // event into a single client-visible send.
      const coalesceTimers = new Map<MinderEventType, NodeJS.Timeout>();
      let heartbeatTimer: NodeJS.Timeout | null = null;

      function close() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        for (const t of coalesceTimers.values()) clearTimeout(t);
        coalesceTimers.clear();
        try { controller.close(); } catch { /* already closed */ }
      }

      function scheduleFlush(type: MinderEventType) {
        if (coalesceTimers.has(type)) return; // already pending — drop
        coalesceTimers.set(type, setTimeout(() => {
          coalesceTimers.delete(type);
          if (closed) return;
          try { controller.enqueue(encode(type, { type })); } catch { close(); }
        }, COALESCE_MS));
      }

      function scheduleHeartbeat() {
        heartbeatTimer = setTimeout(() => {
          if (closed) return;
          try { controller.enqueue(comment("keepalive")); } catch { close(); return; }
          scheduleHeartbeat();
        }, HEARTBEAT_MS);
      }

      // Open the stream immediately so the client's `onopen` fires without
      // waiting for the first real event.
      controller.enqueue(comment("connected"));
      scheduleHeartbeat();

      const unsubscribe = onMinderEvent((ev) => {
        if (closed) return;
        scheduleFlush(ev.type);
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
