import { describe, it, expect, vi, beforeAll } from "vitest";
import { installIsolatedState } from "./_helpers/isolatedState";

// #657: ingest's post-commit events fire on the ingest worker's own buses,
// where nothing listens. The worker relays them (`forwardIngestEvents`) and the
// host re-emits them (`absorbWorkerMessage`). Both halves run in this one
// isolate here, so the relay is disposed before the host half re-emits —
// otherwise the re-emit would be relayed again.

vi.mock("@/lib/serviceLog", () => ({ serviceLog: vi.fn() }));

const state = installIsolatedState({ prefix: "pm-ingest-relay-" });

let forwardIngestEvents: typeof import("@/lib/db/ingestWatcher").forwardIngestEvents;
let absorbWorkerMessage: typeof import("@/lib/db/workerHost").absorbWorkerMessage;
let agentBus: typeof import("@/lib/agentView/eventBus");
let minderBus: typeof import("@/lib/events/bus");

beforeAll(async () => {
  // Dynamic: ingestWatcher reaches db/connection, which pins the ~/.minder
  // path at module evaluation (tests/dbIsolationGuard).
  await state.reload();
  ({ forwardIngestEvents } = await import("@/lib/db/ingestWatcher"));
  ({ absorbWorkerMessage } = await import("@/lib/db/workerHost"));
  agentBus = await import("@/lib/agentView/eventBus");
  minderBus = await import("@/lib/events/bus");
});

const hostState = () => ({ memory: null, watcher: null }) as Parameters<typeof absorbWorkerMessage>[0];

describe("ingest event relay (#657)", () => {
  it("relays ingest's events and the host re-emits them on the main buses", () => {
    const posted: unknown[] = [];
    const stop = forwardIngestEvents((m) => posted.push(m));
    agentBus.bridgeJsonlAppendToEventBus("sess-1", "my-proj");
    minderBus.emitMinderEvent("sessions.changed");
    stop();

    expect(posted).toEqual([
      { type: "agent-event", event: { kind: "jsonl-tail", sessionId: "sess-1", slug: "my-proj" } },
      { type: "minder-event", event: { type: "sessions.changed" } },
    ]);

    const agentEvents: unknown[] = [];
    const minderEvents: unknown[] = [];
    const offAgent = agentBus.onAgentEvent((e) => agentEvents.push(e));
    const offMinder = minderBus.onMinderEvent((e) => minderEvents.push(e));
    // Structured clone, as postMessage would deliver it.
    for (const m of posted) absorbWorkerMessage(hostState(), structuredClone(m));
    offAgent();
    offMinder();

    expect(agentEvents).toEqual([{ kind: "jsonl-tail", sessionId: "sess-1", slug: "my-proj" }]);
    expect(minderEvents).toEqual([{ type: "sessions.changed" }]);
  });

  it("stops relaying once disposed", () => {
    const post = vi.fn();
    forwardIngestEvents(post)();
    agentBus.bridgeJsonlAppendToEventBus("sess-2", "p");
    expect(post).not.toHaveBeenCalled();
  });

  it("a throwing post never reaches the code that emitted the event", () => {
    const stop = forwardIngestEvents(() => {
      throw new Error("port closed");
    });
    expect(() => agentBus.bridgeJsonlAppendToEventBus("sess-3", "p")).not.toThrow();
    stop();
  });

  it("the host drops malformed or unexpected relayed events", () => {
    const agentEvents: unknown[] = [];
    const minderEvents: unknown[] = [];
    const offAgent = agentBus.onAgentEvent((e) => agentEvents.push(e));
    const offMinder = minderBus.onMinderEvent((e) => minderEvents.push(e));

    absorbWorkerMessage(hostState(), { type: "agent-event", event: { kind: "hook", sessionId: "s", slug: "p" } });
    absorbWorkerMessage(hostState(), { type: "agent-event", event: { kind: "jsonl-tail", sessionId: 42, slug: "p" } });
    absorbWorkerMessage(hostState(), { type: "agent-event" });
    absorbWorkerMessage(hostState(), { type: "minder-event", event: { type: "not.a.real.event" } });
    absorbWorkerMessage(hostState(), { type: "minder-event", event: null });
    offAgent();
    offMinder();

    expect(agentEvents).toEqual([]);
    expect(minderEvents).toEqual([]);
  });
});
