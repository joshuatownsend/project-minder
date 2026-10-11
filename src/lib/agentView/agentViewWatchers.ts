import "server-only";
import { startJobRosterWatcher, stopJobRosterWatcher } from "./jobRoster";
import { startJsonlWatcher, stopJsonlWatcher } from "./jsonlWatcher";

// Agent View's two watchers — a second recursive `fs.watch` over
// ~/.claude/projects and the 5 s roster sweep — only serve connected SSE
// clients, so they run only while one is connected (#657). They used to start
// on the first connect and never stop.
//
// The last subscriber leaving starts a grace period instead of stopping at
// once: a page reload or the client's reconnect backoff re-subscribes within
// seconds, and tearing down a recursive watch only to re-arm it is wasted work.

export const GRACE_MS = 30_000;

const g = globalThis as unknown as {
  __minderAgentViewWatchers?: { subscribers: number; graceTimer: NodeJS.Timeout | null };
};

function state() {
  g.__minderAgentViewWatchers ??= { subscribers: 0, graceTimer: null };
  return g.__minderAgentViewWatchers;
}

/**
 * Register one SSE subscriber and make sure the watchers are running. Returns
 * the release function; calling it more than once releases only once.
 */
export function acquireAgentViewWatchers(): () => void {
  const s = state();
  s.subscribers++;
  if (s.graceTimer) {
    clearTimeout(s.graceTimer);
    s.graceTimer = null;
  }
  // Both are idempotent, so a subscriber arriving during the grace period
  // (watchers still running) is a no-op here.
  startJobRosterWatcher();
  startJsonlWatcher();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--s.subscribers > 0) return;
    // acquire() cancels this timer, so it only fires with no subscribers.
    s.graceTimer = setTimeout(() => {
      s.graceTimer = null;
      stopJsonlWatcher();
      stopJobRosterWatcher();
    }, GRACE_MS);
    s.graceTimer.unref?.();
  };
}

/** Subscriber count — for testing only. */
export function _agentViewSubscriberCountForTesting(): number {
  return state().subscribers;
}

/** Reset module state — for testing only. */
export function _resetAgentViewWatchersForTesting(): void {
  const s = g.__minderAgentViewWatchers;
  if (s?.graceTimer) clearTimeout(s.graceTimer);
  delete g.__minderAgentViewWatchers;
}
