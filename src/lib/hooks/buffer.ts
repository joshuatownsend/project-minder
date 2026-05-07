import type { HookEventName } from "@/lib/types";

export interface HookEvent {
  hookEventName: HookEventName;
  sessionId: string;
  cwd: string;
  receivedAt: number; // epoch ms
  toolName?: string;
  message?: string;
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
