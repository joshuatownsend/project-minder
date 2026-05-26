import type { HookEventName } from "@/lib/types";
import type { HookPayload } from "./payload";

export interface HookEvent {
  hookEventName: HookEventName;
  sessionId: string;
  cwd: string;
  receivedAt: number; // epoch ms
  toolName?: string;
  message?: string;
  /** True when a PostToolUse event carried a failure signal (is_error or non-zero return_code). */
  toolFailed?: boolean;
  /**
   * T2.3a: typed discriminated-union view of the JSON body Claude Code
   * POSTed for this event. `null` when the body shape didn't satisfy the
   * variant's required fields. Additive — existing consumers
   * (live-activity, awaiting state, toolFailed) still read the envelope
   * fields above; the payload is for downstream surfaces like the
   * background-tasks / session-crons portfolio view.
   */
  payload?: HookPayload | null;
}

export interface LiveSession {
  slug: string;
  lastEventAt: number;
  lastEventName: HookEventName;
}

const RING_CAP = 50;
const LIVE_TTL_MS = 30_000; // session is "live" if last event within 30s
const STALE_EVICT_MS = 5 * 60_000; // evict sessions inactive for 5 min

export const STOP_EVENTS = new Set<HookEventName>(["Stop", "SubagentStop", "SessionEnd"]);

const g = globalThis as unknown as {
  __minderHookBuffers?: Map<string, HookEvent[]>;
  __minderLiveSessions?: Map<string, LiveSession>;
  __minderAwaiting?: Set<string>;
  __minderAwaitingReported?: Set<string>;
  __minderLastHookReceivedAt?: number;
};

function ensureGlobals(): void {
  g.__minderHookBuffers ??= new Map();
  g.__minderLiveSessions ??= new Map();
  g.__minderAwaiting ??= new Set();
  g.__minderAwaitingReported ??= new Set();
}

export function pushHookEvent(slug: string, event: HookEvent): void {
  ensureGlobals();
  const arr = g.__minderHookBuffers!.get(slug) ?? [];
  arr.push(event);
  if (arr.length > RING_CAP) arr.splice(0, arr.length - RING_CAP);
  g.__minderHookBuffers!.set(slug, arr);
  g.__minderLastHookReceivedAt = event.receivedAt;
}

/** Returns epoch ms of the most recently received hook event, or null if none yet. */
export function getLastHookReceivedAt(): number | null {
  return g.__minderLastHookReceivedAt ?? null;
}

export function updateLiveSession(
  sessionId: string,
  slug: string,
  lastEventName: HookEventName,
): void {
  ensureGlobals();
  g.__minderLiveSessions!.set(sessionId, { slug, lastEventAt: Date.now(), lastEventName });
}

export function clearLiveSession(sessionId: string): void {
  ensureGlobals();
  const sess = g.__minderLiveSessions!.get(sessionId);
  if (!sess) return;
  g.__minderLiveSessions!.delete(sessionId);
  const stillHasSession = [...g.__minderLiveSessions!.values()].some((s) => s.slug === sess.slug);
  if (!stillHasSession) {
    g.__minderAwaiting!.delete(sess.slug);
    g.__minderAwaitingReported!.delete(sess.slug);
  }
}

/** Marks slug as awaiting permission. Returns true if this is a new transition (not already awaiting). */
export function setAwaiting(slug: string): boolean {
  ensureGlobals();
  const isNew = !g.__minderAwaiting!.has(slug);
  g.__minderAwaiting!.add(slug);
  return isNew;
}

export function clearAwaiting(slug: string): void {
  ensureGlobals();
  g.__minderAwaiting!.delete(slug);
  g.__minderAwaitingReported!.delete(slug);
}

/**
 * Returns slugs that entered the awaiting set since the last call, and marks
 * them as reported. Pulse route uses this to emit one-shot change events for
 * toast/notification dispatch without re-firing on subsequent ticks.
 */
export function drainNewAwaitingTransitions(): string[] {
  ensureGlobals();
  const awaiting = g.__minderAwaiting!;
  const reported = g.__minderAwaitingReported!;
  const newSlugs: string[] = [];
  for (const slug of awaiting) {
    if (!reported.has(slug)) {
      newSlugs.push(slug);
      reported.add(slug);
    }
  }
  return newSlugs;
}

/**
 * Called on each /api/pulse tick. Evicts stale sessions and returns the
 * current live + awaiting slug sets. Side-effect: cleans up awaiting entries
 * whose only sessions have expired.
 */
export function sweepAndGetState(): { liveSlugs: string[]; awaitingSlugs: string[] } {
  ensureGlobals();
  const now = Date.now();
  const sessions = g.__minderLiveSessions!;
  const awaiting = g.__minderAwaiting!;

  for (const [id, sess] of sessions) {
    if (now - sess.lastEventAt > STALE_EVICT_MS) {
      sessions.delete(id);
      const still = [...sessions.values()].some((s) => s.slug === sess.slug);
      if (!still) {
        awaiting.delete(sess.slug);
        g.__minderAwaitingReported!.delete(sess.slug);
      }
    }
  }

  const liveSet = new Set<string>();
  for (const sess of sessions.values()) {
    if (now - sess.lastEventAt < LIVE_TTL_MS && !STOP_EVENTS.has(sess.lastEventName)) {
      liveSet.add(sess.slug);
    }
  }

  return { liveSlugs: [...liveSet], awaitingSlugs: [...awaiting] };
}

export function getHookBuffer(slug: string): readonly HookEvent[] {
  ensureGlobals();
  return g.__minderHookBuffers!.get(slug) ?? [];
}

/**
 * T2.3b: aggregate the most recent `background_tasks` + `session_crons`
 * arrays seen across Stop / SubagentStop events for a project. Returns
 * the values from the **latest** Stop/SubagentStop event in the ring
 * buffer for that slug — subsequent stops naturally supersede earlier
 * ones (Claude Code re-emits the current state on each stop).
 *
 * Caveat: the ring buffer evicts entries after `STALE_EVICT_MS` (5 min).
 * If a session's bg-tasks are long-running but no Stop has fired in
 * the last 5 min, the aggregator returns empty — the badge can lie by
 * omission. Documented as a known v1 limitation; SQLite-backed retention
 * is the right T2.4 follow-up.
 */
export function getProjectBackgroundActivity(slug: string): {
  backgroundTasks: unknown[];
  sessionCrons: unknown[];
  lastObservedAt: number | null;
} {
  ensureGlobals();
  const events = g.__minderHookBuffers!.get(slug) ?? [];
  // Walk newest → oldest, take the first Stop / SubagentStop payload
  // with the arrays present.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const p = ev.payload;
    if (!p) continue;
    if (p.kind !== "Stop" && p.kind !== "SubagentStop") continue;
    const bg = p.backgroundTasks ?? [];
    const crons = p.sessionCrons ?? [];
    if (bg.length === 0 && crons.length === 0) continue;
    return { backgroundTasks: bg, sessionCrons: crons, lastObservedAt: ev.receivedAt };
  }
  return { backgroundTasks: [], sessionCrons: [], lastObservedAt: null };
}

/** Returns the set of slugs that currently have any buffered hook events. */
export function getAllSlugsWithBufferedEvents(): string[] {
  ensureGlobals();
  return Array.from(g.__minderHookBuffers!.keys());
}
