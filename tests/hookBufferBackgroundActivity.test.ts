import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProjectBackgroundActivity,
  getAllSlugsWithBufferedEvents,
  pushHookEvent,
  type HookEvent,
} from "@/lib/hooks/buffer";
import type { HookPayload } from "@/lib/hooks/payload";

/**
 * Tests for T2.3b's aggregator helper that the `/background` portfolio
 * page + `/api/hooks/background-activity` route depend on. Pushes
 * synthetic HookEvents into the ring buffer (no HTTP, no parser, no flag
 * gate) and verifies the read-side picks up the latest `background_tasks`
 * / `session_crons` arrays per project.
 */

// Reset the globalThis ring buffer between tests so prior pushes don't bleed.
function resetBuffer(): void {
  const g = globalThis as unknown as {
    __minderHookBuffers?: Map<string, HookEvent[]>;
    __minderLiveSessions?: Map<string, unknown>;
    __minderAwaiting?: Set<string>;
    __minderAwaitingReported?: Set<string>;
  };
  g.__minderHookBuffers = new Map();
  g.__minderLiveSessions = new Map();
  g.__minderAwaiting = new Set();
  g.__minderAwaitingReported = new Set();
}

function makeEvent(
  slug: string,
  payload: HookPayload,
  receivedAtOffsetMs = 0,
): HookEvent {
  return {
    hookEventName: payload.kind,
    sessionId: `s-${slug}`,
    cwd: `/repo/${slug}`,
    receivedAt: Date.now() + receivedAtOffsetMs,
    payload,
  };
}

describe("getProjectBackgroundActivity", () => {
  beforeEach(resetBuffer);
  afterEach(resetBuffer);

  it("returns empty when the project has no buffered events", () => {
    const r = getProjectBackgroundActivity("nonexistent");
    expect(r.backgroundTasks).toEqual([]);
    expect(r.sessionCrons).toEqual([]);
    expect(r.lastObservedAt).toBeNull();
  });

  it("returns the latest Stop payload's bg_tasks / crons", () => {
    const bg = [{ task_id: "t1", command: "npm run build" }];
    const crons = [{ schedule: "*/5 * * * *", command: "heartbeat" }];
    pushHookEvent(
      "myapp",
      makeEvent("myapp", {
        kind: "Stop",
        backgroundTasks: bg,
        sessionCrons: crons,
      }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual(bg);
    expect(r.sessionCrons).toEqual(crons);
    expect(r.lastObservedAt).toBeGreaterThan(0);
  });

  it("takes the most recent Stop when multiple are buffered", () => {
    // Older Stop has different data; newer wins.
    pushHookEvent(
      "myapp",
      makeEvent(
        "myapp",
        { kind: "Stop", backgroundTasks: [{ task_id: "old" }], sessionCrons: [] },
        -10_000,
      ),
    );
    pushHookEvent(
      "myapp",
      makeEvent("myapp", {
        kind: "Stop",
        backgroundTasks: [{ task_id: "new" }],
        sessionCrons: [],
      }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([{ task_id: "new" }]);
  });

  it("accepts SubagentStop payloads as a fallback source", () => {
    // Per docs, SubagentStop also carries bg_tasks/crons scoped to the
    // parent session. If the most recent stop event is a SubagentStop
    // (no parent Stop has fired yet), the aggregator should still pick
    // it up.
    pushHookEvent(
      "myapp",
      makeEvent("myapp", {
        kind: "SubagentStop",
        agentId: "ag1",
        agentType: "Explore",
        backgroundTasks: [{ task_id: "from-sub" }],
        sessionCrons: [],
      }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([{ task_id: "from-sub" }]);
  });

  it("skips Stop events that omit both keys entirely (pre-v2.1.145 shape)", () => {
    // Pre-v2.1.145 Stop bodies don't carry bg_tasks/crons at all → both
    // fields land as `undefined` in the parsed payload. That's "no info",
    // not "explicit empty", so the aggregator should keep walking and
    // surface the prior non-empty Stop.
    pushHookEvent(
      "myapp",
      makeEvent(
        "myapp",
        { kind: "Stop", backgroundTasks: [{ task_id: "real" }], sessionCrons: [] },
        -10_000,
      ),
    );
    pushHookEvent("myapp", makeEvent("myapp", { kind: "Stop" }));
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([{ task_id: "real" }]);
  });

  it("treats latest Stop with explicit empty arrays as authoritative clear", () => {
    // Claude Code's Stop hook is a snapshot — `background_tasks: []` means
    // "no tasks running right now". A task finishing should clear the
    // surface, not resurrect an older non-empty payload. Distinguishes
    // explicit `[]` from undefined-key absence handled above.
    pushHookEvent(
      "myapp",
      makeEvent(
        "myapp",
        { kind: "Stop", backgroundTasks: [{ task_id: "done" }], sessionCrons: [] },
        -10_000,
      ),
    );
    pushHookEvent(
      "myapp",
      makeEvent("myapp", { kind: "Stop", backgroundTasks: [], sessionCrons: [] }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([]);
    expect(r.sessionCrons).toEqual([]);
    // We did observe a Stop — `lastObservedAt` is the cleared event's time,
    // not null. The route layer drops projects whose arrays are both empty.
    expect(r.lastObservedAt).toBeGreaterThan(0);
  });

  it("ignores Stop events older than STALE_EVICT_MS (5 min)", () => {
    // A stale Stop carrying real data should not surface — the API, UI,
    // and docs all claim this is a "last ~5 min" view.
    pushHookEvent(
      "myapp",
      makeEvent(
        "myapp",
        {
          kind: "Stop",
          backgroundTasks: [{ task_id: "old-but-real" }],
          sessionCrons: [{ schedule: "*/5 * * * *" }],
        },
        -6 * 60_000, // 6 min ago, beyond the 5-min freshness window
      ),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([]);
    expect(r.sessionCrons).toEqual([]);
    expect(r.lastObservedAt).toBeNull();
  });

  it("returns a fresh Stop even when an older stale Stop sits behind it", () => {
    // Walk-and-break: newest→oldest scan must surface the fresh entry
    // before the stale-age check causes a break.
    pushHookEvent(
      "myapp",
      makeEvent(
        "myapp",
        { kind: "Stop", backgroundTasks: [{ task_id: "stale" }], sessionCrons: [] },
        -10 * 60_000, // 10 min ago — beyond TTL
      ),
    );
    pushHookEvent(
      "myapp",
      makeEvent("myapp", {
        kind: "Stop",
        backgroundTasks: [{ task_id: "fresh" }],
        sessionCrons: [],
      }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([{ task_id: "fresh" }]);
  });

  it("ignores non-Stop hook events", () => {
    pushHookEvent(
      "myapp",
      makeEvent("myapp", {
        kind: "PostToolUse",
        toolName: "Bash",
        toolInput: { command: "echo hi" },
      }),
    );
    const r = getProjectBackgroundActivity("myapp");
    expect(r.backgroundTasks).toEqual([]);
    expect(r.lastObservedAt).toBeNull();
  });

  it("scopes to a single slug — sibling projects don't bleed", () => {
    pushHookEvent(
      "appA",
      makeEvent("appA", {
        kind: "Stop",
        backgroundTasks: [{ task_id: "A" }],
        sessionCrons: [],
      }),
    );
    pushHookEvent(
      "appB",
      makeEvent("appB", {
        kind: "Stop",
        backgroundTasks: [{ task_id: "B" }],
        sessionCrons: [],
      }),
    );
    expect(getProjectBackgroundActivity("appA").backgroundTasks).toEqual([
      { task_id: "A" },
    ]);
    expect(getProjectBackgroundActivity("appB").backgroundTasks).toEqual([
      { task_id: "B" },
    ]);
  });
});

describe("getAllSlugsWithBufferedEvents", () => {
  beforeEach(resetBuffer);
  afterEach(resetBuffer);

  it("returns empty when no events have been pushed", () => {
    expect(getAllSlugsWithBufferedEvents()).toEqual([]);
  });

  it("returns the unique set of slugs that have any buffered events", () => {
    pushHookEvent(
      "appA",
      makeEvent("appA", {
        kind: "PostToolUse",
        toolName: "Bash",
      }),
    );
    pushHookEvent(
      "appB",
      makeEvent("appB", { kind: "Stop" }),
    );
    const slugs = getAllSlugsWithBufferedEvents().sort();
    expect(slugs).toEqual(["appA", "appB"]);
  });
});
