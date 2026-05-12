import { NextRequest } from "next/server";
import { onAgentEvent } from "@/lib/agentView/eventBus";
import { aggregateLiveSessions } from "@/lib/agentView/aggregate";
import { startJobRosterWatcher } from "@/lib/agentView/jobRoster";
import { readConfig } from "@/lib/config";

// SSE endpoint for the Agent View live Kanban.
//
// On connect:
//   1. Emits a "snapshot" event with the current aggregated session list.
//   2. Subscribes to the globalThis EventEmitter for live events.
//   3. On each live event, re-aggregates and emits a "snapshot" delta.
//   4. Heartbeats every 15 s as a comment line to defeat proxy timeouts.
//
// Cleanup is driven by request.signal so the listener is removed when the
// client disconnects. Multiple concurrent tabs share the same globalThis
// emitter; setMaxListeners(50) in eventBus.ts ensures no Node warning.
//
// Coalescing: drops intermediate events < 200 ms apart for the same
// session so a fast Bash burst doesn't flood the client.

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

  // Ensure watcher is running (idempotent due to globalThis guard)
  startJobRosterWatcher();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // Per-session coalesce timers: sessionId → timeout
      const coalesceTimers = new Map<string, NodeJS.Timeout>();
      let heartbeatTimer: NodeJS.Timeout | null = null;

      function close() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        for (const t of coalesceTimers.values()) clearTimeout(t);
        coalesceTimers.clear();
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

      function scheduleCoalesce(sessionId: string) {
        const existing = coalesceTimers.get(sessionId);
        if (existing) return; // already pending — drop this event
        coalesceTimers.set(sessionId, setTimeout(() => {
          coalesceTimers.delete(sessionId);
          sendSnapshot();
        }, COALESCE_MS));
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
      const unsubscribe = onAgentEvent((ev) => {
        if (closed) return;
        scheduleCoalesce(ev.sessionId);
      });

      // Cleanup on disconnect
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
