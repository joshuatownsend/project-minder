import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushHookEvent,
  getLastHookReceivedAt,
} from "@/lib/hooks/buffer";
import { hasRecentToolFailure } from "@/lib/agentView/aggregate";
import type { HookEvent } from "@/lib/hooks/buffer";

// Reset the globalThis cache between tests to avoid state bleed.
const g = globalThis as Record<string, unknown>;
function resetBuffers() {
  delete g.__minderHookBuffers;
  delete g.__minderLiveSessions;
  delete g.__minderAwaiting;
  delete g.__minderAwaitingReported;
  delete g.__minderLastHookReceivedAt;
}

const NOW = 1_700_000_000_000;

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    hookEventName: "PostToolUse",
    sessionId: "s1",
    cwd: "/tmp/proj",
    receivedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  resetBuffers();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("getLastHookReceivedAt", () => {
  it("returns null before any hook is pushed", () => {
    expect(getLastHookReceivedAt()).toBeNull();
  });

  it("returns the receivedAt of the most recently pushed event", () => {
    pushHookEvent("proj", makeEvent({ receivedAt: NOW - 5000 }));
    pushHookEvent("proj", makeEvent({ receivedAt: NOW }));
    expect(getLastHookReceivedAt()).toBe(NOW);
  });
});

describe("hasRecentToolFailure", () => {
  it("returns false for an empty buffer", () => {
    expect(hasRecentToolFailure([], NOW)).toBe(false);
  });

  it("returns false when the most recent PostToolUse succeeded", () => {
    const events = [
      makeEvent({ toolFailed: true, receivedAt: NOW - 10_000 }),
      makeEvent({ toolFailed: false, receivedAt: NOW - 5_000 }),
    ];
    expect(hasRecentToolFailure(events, NOW)).toBe(false);
  });

  it("returns true when the most recent PostToolUse failed within 2 minutes", () => {
    const events = [makeEvent({ toolFailed: true, receivedAt: NOW - 30_000 })];
    expect(hasRecentToolFailure(events, NOW)).toBe(true);
  });

  it("returns false when the failing event is older than 2 minutes", () => {
    const events = [makeEvent({ toolFailed: true, receivedAt: NOW - 130_000 })];
    expect(hasRecentToolFailure(events, NOW)).toBe(false);
  });

  it("ignores non-PostToolUse events when scanning for the most recent", () => {
    const events: HookEvent[] = [
      makeEvent({ toolFailed: true, receivedAt: NOW - 10_000 }),
      { ...makeEvent(), hookEventName: "PreToolUse", receivedAt: NOW - 1_000 },
    ];
    // Most recent PostToolUse (at NOW-10s) failed → true
    expect(hasRecentToolFailure(events, NOW)).toBe(true);
  });

  it("returns false when only non-PostToolUse events are present", () => {
    const events: HookEvent[] = [
      { ...makeEvent(), hookEventName: "PreToolUse" },
      { ...makeEvent(), hookEventName: "UserPromptSubmit" },
    ];
    expect(hasRecentToolFailure(events, NOW)).toBe(false);
  });
});
