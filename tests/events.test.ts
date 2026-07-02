import { describe, it, expect, vi } from "vitest";
import { MINDER_EVENT_TYPES } from "@/lib/events/types";
import { eventToQueryPrefixes } from "@/lib/events/invalidation";
import { emitMinderEvent, onMinderEvent } from "@/lib/events/bus";
import { FEATURE_FLAG_META, getFlag } from "@/lib/featureFlags";

// ── event → query-prefix mapping ─────────────────────────────────────────────
describe("eventToQueryPrefixes", () => {
  it("maps sessions.changed to the sessions prefix", () => {
    expect(eventToQueryPrefixes("sessions.changed")).toEqual([["sessions"]]);
  });

  it("maps scan.invalidated to the scan-derived resource prefixes", () => {
    expect(eventToQueryPrefixes("scan.invalidated")).toEqual([
      ["insights"],
      ["stats"],
      ["manual-steps"],
    ]);
  });

  it("maps the git/github cache events to no query keys (non-Query hooks)", () => {
    // These drive useGitDirtyStatus / useGithubActivity via the provider's
    // subscriber fan-out, not the TanStack Query cache.
    expect(eventToQueryPrefixes("git-status.updated")).toEqual([]);
    expect(eventToQueryPrefixes("github-activity.updated")).toEqual([]);
  });

  it("handles every declared event type and returns valid (possibly empty) key arrays", () => {
    for (const type of MINDER_EVENT_TYPES) {
      const prefixes = eventToQueryPrefixes(type);
      expect(Array.isArray(prefixes)).toBe(true);
      // Any prefix returned is itself a non-empty key array.
      for (const key of prefixes) expect(key.length).toBeGreaterThan(0);
    }
  });
});

// ── event bus (emit / subscribe / unsubscribe) ───────────────────────────────
describe("event bus", () => {
  it("delivers an emitted event to a subscriber as { type }", () => {
    const seen: string[] = [];
    const off = onMinderEvent((ev) => seen.push(ev.type));
    try {
      emitMinderEvent("sessions.changed");
      emitMinderEvent("scan.invalidated");
    } finally {
      off();
    }
    expect(seen).toEqual(["sessions.changed", "scan.invalidated"]);
  });

  it("stops delivering after the disposer runs", () => {
    const listener = vi.fn();
    const off = onMinderEvent(listener);
    emitMinderEvent("sessions.changed");
    off();
    emitMinderEvent("sessions.changed");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fans out to multiple concurrent subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onMinderEvent(a);
    const offB = onMinderEvent(b);
    try {
      emitMinderEvent("scan.invalidated");
    } finally {
      offA();
      offB();
    }
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

// ── flag default (Settings toggle vs client gate parity) ─────────────────────
describe("liveEvents is opt-in (default off)", () => {
  it("meta marks defaultOn:false so the Settings toggle matches the client gate", () => {
    const meta = FEATURE_FLAG_META.find((m) => m.key === "liveEvents");
    expect(meta?.defaultOn).toBe(false);
    expect(getFlag({}, "liveEvents", meta?.defaultOn ?? true)).toBe(false);
    expect(getFlag(undefined, "liveEvents", false)).toBe(false);
    expect(getFlag({ liveEvents: true }, "liveEvents", false)).toBe(true);
  });
});
