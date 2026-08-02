import type { QuotaResult, QuotaWindow } from "../quota";

/**
 * Quota-aware dispatch gate (pure).
 *
 * Connects two systems that already existed separately: `quota.ts` reads the
 * authoritative `anthropic-ratelimit-unified-*` headers (including a real
 * `resetAt` per window), and `tasks/dispatcher.ts` spawns queued work. Without
 * the gate, a task claimed while the window is exhausted spawns straight into
 * the wall, fails, and is gone — the dispatcher has no retry. Holding the queue
 * until `resetAt` turns a lost task into a late one.
 *
 * The queue is held rather than rescheduled: nothing is written to
 * `ops_tasks.scheduled_for`. Stamping a reset time onto every pending row would
 * mean owning the un-stamping too, and would strand the queue behind a stale
 * timestamp if quota recovered early or the reading turned out to be wrong.
 * Pending rows stay pending and the next tick (~30 s) claims them the moment
 * the gate opens, which also means a user's own `scheduled_for` is never
 * touched.
 *
 * **Every unclear case fails open.** A gate that holds on bad data silently
 * stops all background work, which is far worse than letting one task fail: the
 * failure is visible and the stall is not.
 */

/**
 * Utilization at or above which dispatch holds, when the header hasn't yet
 * flipped `status` away from "allowed". Set below 1.0 because a long task
 * started at 99% hits the wall mid-run and dies with its work unsaved, while
 * the cost of holding is a delay bounded by `resetAt`.
 */
export const DEFAULT_THRESHOLD = 0.98;

/**
 * How stale a quota reading may be and still gate.
 *
 * `loadQuota()` falls back to the on-disk cache when its probe fails, so a
 * `QuotaData` can be arbitrarily old. An hour-old "throttled" reading would
 * otherwise hold the queue indefinitely against a window that has long since
 * reset.
 */
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Longest hold treated as plausible. The 7-day window can legitimately reset
 * up to a week out, so this only rejects readings whose `resetAt` is beyond
 * anything the API issues — a corrupt cache rather than a real limit.
 */
export const MAX_HOLD_MS = 8 * 24 * 60 * 60 * 1000;

export interface QuotaGateOptions {
  enabled?: boolean;
  threshold?: number;
  maxAgeMs?: number;
}

export interface QuotaGateDecision {
  hold: boolean;
  /** ISO timestamp the hold lifts at. Only set when `hold` is true. */
  until?: string;
  /** Windows that were exhausted, e.g. `["5h"]`. */
  windows?: string[];
  /** Always populated — the heartbeat and the UI show this either way. */
  reason: string;
}

const OPEN = (reason: string): QuotaGateDecision => ({ hold: false, reason });

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Statuses that authoritatively mean "this window is spent".
 *
 * An allowlist, not `status !== "allowed"`. `parseWindow()` defaults the
 * status to the literal string `"unknown"` whenever the header is simply
 * absent, so the negative test treated a perfectly ordinary incomplete
 * reading as throttled — and, with a valid future reset alongside it, would
 * pause the entire default-on task queue for up to eight days. Only a
 * recognized bad status short-circuits; anything unfamiliar falls through to
 * the utilization check, which is the documented fail-open behaviour.
 */
const THROTTLED_STATUSES = new Set(["throttled", "rejected", "blocked", "exceeded", "exhausted"]);

function isExhausted(window: QuotaWindow | undefined, threshold: number): boolean {
  if (!window) return false;
  // A known-bad status is authoritative; utilization is the early warning.
  if (typeof window.status === "string" && THROTTLED_STATUSES.has(window.status.trim().toLowerCase())) {
    return true;
  }
  return typeof window.utilization === "number" && window.utilization >= threshold;
}

/**
 * Decide whether the dispatcher should hold off spawning.
 *
 * `now` is injected so the decision is testable without freezing the clock.
 */
export function evaluateQuotaGate(
  quota: QuotaResult | null,
  options: QuotaGateOptions = {},
  now: number = Date.now(),
): QuotaGateDecision {
  const {
    enabled = true,
    threshold = DEFAULT_THRESHOLD,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  } = options;

  if (!enabled) return OPEN("quota gate disabled");
  if (!quota) return OPEN("no quota reading");
  if (!quota.configured) return OPEN("quota not configured");

  const cachedAt = parseIso(quota.cachedAt);
  if (cachedAt === null) return OPEN("quota reading has no usable timestamp");
  // A future-dated reading means a clock skew we can't reason about; treat it
  // as unusable rather than trusting it.
  const age = now - cachedAt;
  if (age < 0 || age > maxAgeMs) {
    return OPEN(`quota reading is ${age < 0 ? "future-dated" : "stale"} — not gating on it`);
  }

  const exhausted: { name: string; resetAt: number }[] = [];
  for (const [name, window] of Object.entries(quota.windows ?? {})) {
    if (!isExhausted(window as QuotaWindow, threshold)) continue;
    const resetAt = parseIso((window as QuotaWindow).resetAt);
    // An exhausted window with no readable reset time gives nothing to wait
    // for. Holding indefinitely is the one outcome worse than a failed task.
    if (resetAt === null) return OPEN(`${name} window is exhausted but carries no reset time`);
    exhausted.push({ name, resetAt });
  }

  if (exhausted.length === 0) return OPEN("quota available");

  // Every exhausted window has to clear, so the hold runs to the LATEST reset
  // among them. Waiting only for the 5h reset while the 7d window is also
  // exhausted would release the queue straight back into the wall.
  const until = Math.max(...exhausted.map((e) => e.resetAt));
  if (until <= now) return OPEN("quota window already reset");
  if (until - now > MAX_HOLD_MS) {
    return OPEN("quota reset is implausibly far out — not gating on it");
  }

  const names = exhausted.map((e) => e.name).sort();
  return {
    hold: true,
    until: new Date(until).toISOString(),
    windows: names,
    reason: `${names.join(" + ")} quota exhausted; dispatch resumes at ${new Date(until).toISOString()}`,
  };
}
