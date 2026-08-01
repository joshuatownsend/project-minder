/**
 * Notification rules engine — pending `os`-channel deliveries.
 *
 * The `push` and `telegram` channels are server-side transports the engine can
 * call directly. `os` is not: an OS notification can only be raised by a
 * browser that has been granted permission, so a match destined for `os` has
 * to survive until a tab asks for it.
 *
 * This queue is that handoff. `/api/pulse` drains it on each poll and emits
 * the entries as `PulseChange`s, which `NotificationListener` already knows how
 * to turn into a toast and a `Notification` — the same route
 * `awaiting-permission` takes via `drainNewAwaitingTransitions`.
 *
 * Edge-triggered by draining: an entry is delivered once. With several tabs
 * open, whichever polls first gets it — matching the existing awaiting-
 * permission behaviour rather than inventing a second, per-tab convention.
 */

import type { RuleSeverity } from "./types";

export interface PendingOsNotification {
  ruleId: string;
  ruleName: string;
  severity: RuleSeverity;
  projectSlug: string;
  projectName: string;
  excerpt: string;
  at: string;
}

/**
 * Bounded so a rule matching a hot tool cannot grow the queue without limit
 * when no browser is open to drain it. Oldest entries are dropped first: a
 * stale alert is worth less than a current one.
 */
const MAX_QUEUED = 50;

interface OsQueueState {
  queue: PendingOsNotification[];
}

const KEY = "__minderRuleOsQueue" as const;

function state(): OsQueueState {
  const g = globalThis as typeof globalThis & { [KEY]?: OsQueueState };
  if (!g[KEY]) g[KEY] = { queue: [] };
  return g[KEY];
}

export function queueOsNotification(entry: PendingOsNotification): void {
  const s = state();
  s.queue.push(entry);
  if (s.queue.length > MAX_QUEUED) {
    s.queue.splice(0, s.queue.length - MAX_QUEUED);
  }
}

/** Remove and return everything queued. */
export function drainOsNotifications(): PendingOsNotification[] {
  const s = state();
  if (s.queue.length === 0) return [];
  const out = s.queue;
  s.queue = [];
  return out;
}

/** Number of entries waiting, without draining. */
export function pendingOsCount(): number {
  return state().queue.length;
}

/** Test-only: reset the queue. */
export function resetOsQueue(): void {
  state().queue = [];
}
