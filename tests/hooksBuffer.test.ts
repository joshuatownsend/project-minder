import { describe, it, expect, beforeEach } from "vitest";
import {
  pushHookEvent,
  updateLiveSession,
  clearLiveSession,
  setAwaiting,
  clearAwaiting,
  sweepAndGetState,
  getHookBuffer,
  type HookEvent,
} from "@/lib/hooks/buffer";

// Reset globalThis singletons between tests
function resetGlobals() {
  const g = globalThis as Record<string, unknown>;
  delete g.__minderHookBuffers;
  delete g.__minderLiveSessions;
  delete g.__minderAwaiting;
}

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    hookEventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/dev/foo",
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("ring buffer", () => {
  beforeEach(resetGlobals);

  it("stores events per slug", () => {
    pushHookEvent("foo", makeEvent({ toolName: "Bash" }));
    pushHookEvent("bar", makeEvent({ toolName: "Read" }));
    expect(getHookBuffer("foo")).toHaveLength(1);
    expect(getHookBuffer("bar")).toHaveLength(1);
    expect(getHookBuffer("baz")).toHaveLength(0);
  });

  it("caps at 50 with FIFO eviction", () => {
    for (let i = 0; i < 55; i++) {
      pushHookEvent("slug", makeEvent({ receivedAt: i }));
    }
    const buf = getHookBuffer("slug");
    expect(buf).toHaveLength(50);
    // Oldest 5 were evicted; first surviving event has receivedAt === 5
    expect(buf[0].receivedAt).toBe(5);
  });
});

describe("live session tracking", () => {
  beforeEach(resetGlobals);

  it("marks a slug as live within TTL", () => {
    updateLiveSession("s1", "proj", "PreToolUse");
    const { liveSlugs } = sweepAndGetState();
    expect(liveSlugs).toContain("proj");
  });

  it("does not mark a slug live when last event is a stop event", () => {
    updateLiveSession("s1", "proj", "Stop");
    const { liveSlugs } = sweepAndGetState();
    expect(liveSlugs).not.toContain("proj");
  });

  it("evicts sessions older than 5 minutes", () => {
    const staleAt = Date.now() - 6 * 60_000;
    updateLiveSession("s1", "proj", "PreToolUse");
    // Manually set the timestamp to simulate staleness
    const g = globalThis as { __minderLiveSessions?: Map<string, { slug: string; lastEventAt: number; lastEventName: string }> };
    g.__minderLiveSessions!.set("s1", { slug: "proj", lastEventAt: staleAt, lastEventName: "PreToolUse" });
    const { liveSlugs } = sweepAndGetState();
    expect(liveSlugs).not.toContain("proj");
    // Session should be removed
    expect(g.__minderLiveSessions!.has("s1")).toBe(false);
  });

  it("clearLiveSession removes session and clears awaiting if no other session for slug", () => {
    updateLiveSession("s1", "proj", "Notification");
    setAwaiting("proj");
    clearLiveSession("s1");
    const { awaitingSlugs } = sweepAndGetState();
    expect(awaitingSlugs).not.toContain("proj");
  });

  it("clearLiveSession keeps awaiting if another session for slug remains", () => {
    updateLiveSession("s1", "proj", "Notification");
    updateLiveSession("s2", "proj", "PreToolUse");
    setAwaiting("proj");
    clearLiveSession("s1");
    const { awaitingSlugs } = sweepAndGetState();
    expect(awaitingSlugs).toContain("proj");
  });
});

describe("awaiting state", () => {
  beforeEach(resetGlobals);

  it("setAwaiting returns true on new transition", () => {
    expect(setAwaiting("proj")).toBe(true);
  });

  it("setAwaiting returns false if already awaiting", () => {
    setAwaiting("proj");
    expect(setAwaiting("proj")).toBe(false);
  });

  it("clearAwaiting removes the slug", () => {
    setAwaiting("proj");
    clearAwaiting("proj");
    const { awaitingSlugs } = sweepAndGetState();
    expect(awaitingSlugs).not.toContain("proj");
  });
});
