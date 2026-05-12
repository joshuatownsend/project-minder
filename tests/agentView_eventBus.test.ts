import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";

// Test the EventEmitter-based event bus pattern in isolation, without pulling
// in the server-only agentView/eventBus module.

const EVENT = "live:agent";

type LiveAgentEvent = {
  kind: "hook" | "jsonl-tail" | "daemon-change";
  sessionId: string;
  slug: string;
};

function makeLocalBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  function emit(event: LiveAgentEvent): void {
    bus.emit(EVENT, event);
  }

  function subscribe(listener: (ev: LiveAgentEvent) => void): () => void {
    bus.on(EVENT, listener);
    return () => bus.off(EVENT, listener);
  }

  return { emit, subscribe, bus };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agentView eventBus pattern", () => {
  it("delivers events to subscribers", () => {
    const { emit, subscribe } = makeLocalBus();
    const events: LiveAgentEvent[] = [];
    subscribe((ev) => events.push(ev));
    emit({ kind: "hook", sessionId: "s1", slug: "proj" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("hook");
    expect(events[0].sessionId).toBe("s1");
  });

  it("unsubscribe removes the listener", () => {
    const { emit, subscribe } = makeLocalBus();
    const events: LiveAgentEvent[] = [];
    const unsub = subscribe((ev) => events.push(ev));
    emit({ kind: "jsonl-tail", sessionId: "s2", slug: "proj" });
    unsub();
    emit({ kind: "jsonl-tail", sessionId: "s3", slug: "proj" });
    expect(events).toHaveLength(1); // second event was not received
  });

  it("multiple subscribers all receive the same event", () => {
    const { emit, subscribe } = makeLocalBus();
    const a: string[] = [];
    const b: string[] = [];
    subscribe((ev) => a.push(ev.sessionId));
    subscribe((ev) => b.push(ev.sessionId));
    emit({ kind: "daemon-change", sessionId: "s4", slug: "proj" });
    expect(a).toEqual(["s4"]);
    expect(b).toEqual(["s4"]);
  });

  it("max listeners raised to 50 so no Node warning fires", () => {
    const bus = new EventEmitter();
    bus.setMaxListeners(50);
    expect(bus.getMaxListeners()).toBe(50);
  });

  it("AbortSignal cleanup pattern removes listener", () => {
    const { emit, subscribe, bus } = makeLocalBus();
    const ac = new AbortController();
    const events: LiveAgentEvent[] = [];

    const unsub = subscribe((ev) => events.push(ev));
    ac.signal.addEventListener("abort", unsub);

    emit({ kind: "hook", sessionId: "s5", slug: "proj" });
    expect(events).toHaveLength(1);

    ac.abort();
    emit({ kind: "hook", sessionId: "s6", slug: "proj" });
    expect(events).toHaveLength(1); // s6 not received after abort

    expect(bus.listenerCount(EVENT)).toBe(0);
  });
});
