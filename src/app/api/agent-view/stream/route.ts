import { NextRequest } from "next/server";
import { onAgentEvent } from "@/lib/agentView/eventBus";
import { aggregateLiveSessions } from "@/lib/agentView/aggregate";
import { refreshRoster } from "@/lib/agentView/jobRoster";
import { acquireAgentViewWatchers } from "@/lib/agentView/agentViewWatchers";
import { readConfig } from "@/lib/config";

// SSE endpoint for the Agent View live Kanban.
//
// On connect:
//   1. Emits a "snapshot" event with the current aggregated session list.
//   2. Subscribes to the globalThis EventEmitter for live events.
//   3. On each live event, re-aggregates and emits a "snapshot" delta.
//   4. Heartbeats every 15 s as a comment line to defeat proxy timeouts.
//
// Cleanup is driven by request.signal so the listener is removed — and this
// subscriber's hold on the watchers released (#657) — when the client
// disconnects. Multiple concurrent tabs share the same globalThis
// emitter; setMaxListeners(50) in eventBus.ts ensures no Node warning.
//
// Coalescing: every snapshot covers ALL sessions, so one pending snapshot
// absorbs every event in the next 200 ms, whichever session it names. A fast
// Bash burst, or a full re-index relaying one event per session (#657), costs
// one snapshot per window rather than one per session.

const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 200;

function encode(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

function heartbeat(): Uint8Array {
  return new TextEncoder().encode(`:keepalive\n\n`);
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = await readConfig();
  const abandonMin = config.agentView?.abandonThresholdMin;

  // Hold the watchers for this connection's lifetime, then wait for the initial
  // roster load so the first snapshot includes daemon sessions.
  const releaseWatchers = acquireAgentViewWatchers();
  await refreshRoster();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let coalesceTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;

      function close() {
        if (closed) return;
        closed = true;
        releaseWatchers();
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (coalesceTimer) clearTimeout(coalesceTimer);
        try { controller.close(); } catch { /* already closed */ }
      }

      async function sendSnapshot() {
        if (closed) return;
        try {
          const sessions = await aggregateLiveSessions(abandonMin);
          controller.enqueue(encode("snapshot", { sessions, generatedAt: new Date().toISOString() }));
        } catch {
          // Non-fatal — client will retry on next event or heartbeat
        }
      }

      function scheduleCoalesce() {
        if (coalesceTimer) return; // a snapshot is already pending — it will include this event
        coalesceTimer = setTimeout(() => {
          coalesceTimer = null;
          sendSnapshot();
        }, COALESCE_MS);
      }

      function scheduleHeartbeat() {
        heartbeatTimer = setTimeout(() => {
          if (closed) return;
          try { controller.enqueue(heartbeat()); } catch { close(); return; }
          scheduleHeartbeat();
        }, HEARTBEAT_MS);
      }

      // Initial snapshot
      sendSnapshot();
      scheduleHeartbeat();

      // Subscribe to live events
      const unsubscribe = onAgentEvent(() => {
        if (closed) return;
        scheduleCoalesce();
      });

      // Cleanup on disconnect. A client that left during the awaits above has
      // already fired `abort`, which a listener added now would never see.
      const cleanup = () => {
        unsubscribe();
        close();
      };
      if (request.signal.aborted) cleanup();
      else request.signal.addEventListener("abort", cleanup, { once: true });
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
