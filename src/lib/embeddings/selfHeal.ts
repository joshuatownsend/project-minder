/**
 * Should this dispatcher tick spend CPU topping up the embedding index?
 *
 * Pure and dependency-free (no `server-only`, no DB, no clock), so the policy
 * that decides to spend background CPU is testable in isolation. The dispatcher
 * owns the state; this module owns the rules.
 *
 * The shape of the problem: the tick fires every ~30 s and exists to dispatch
 * agent tasks. Embedding is CPU-bound and competes with exactly that work, so
 * self-heal runs only in the gaps — never alongside a running task, never twice
 * at once, and backing off hard whenever a pass reports there is nothing to do
 * or nothing it can do.
 */

/**
 * Chunks per tick. ~3.8 s of CPU at the measured 15.3 ms/chunk — roughly a 12%
 * duty cycle against a 30 s tick.
 *
 * Sized for *drift*, not for bulk: a few hundred chunks from newly ingested
 * sessions clear in a tick or two. Embedding a cold 157 000-chunk corpus this
 * way would take hours, which is the correct speed for something nobody asked
 * for in the moment — the Settings panel's Build button remains the fast path
 * for anyone who wants it done now.
 */
export const SELF_HEAL_CHUNKS = 250;

/** ~10 min. Nothing to embed; new sessions arrive on a human timescale. */
export const IDLE_COOLDOWN_TICKS = 20;
/** ~20 min. A pass failed; don't retry a broken thing every 30 seconds. */
export const ERROR_COOLDOWN_TICKS = 40;
/**
 * ~1 hour. A missing model or a missing chunk corpus needs an install or a
 * migration to fix — it will not resolve itself on a ten-minute timer, and
 * retrying costs a `pruneInvalidVectors` sweep every time.
 */
export const BLOCKED_COOLDOWN_TICKS = 120;

export interface SelfHealState {
  /** Ticks still to skip before the next attempt. */
  cooldownTicks: number;
  /** A pass is in flight. The tick does not await it, so this is the only guard. */
  running: boolean;
}

export function initialSelfHealState(): SelfHealState {
  return { cooldownTicks: 0, running: false };
}

export interface SelfHealGateInput {
  /** Both `semanticSearch` and `semanticAutoBackfill` are on. */
  enabled: boolean;
  /** Shutdown has begun. */
  stopped: boolean;
  /** Tasks this dispatcher is currently supervising. */
  inFlightTasks: number;
  state: SelfHealState;
}

export function shouldRunSelfHeal(input: SelfHealGateInput): boolean {
  const { enabled, stopped, inFlightTasks, state } = input;
  if (!enabled) return false;
  if (stopped) return false;
  // Never while the dispatcher is actually dispatching. Embedding would be
  // competing for CPU with the agents this process exists to run, and a
  // background nicety must never slow down foreground work.
  if (inFlightTasks > 0) return false;
  if (state.running) return false;
  if (state.cooldownTicks > 0) return false;
  return true;
}

/** Consume one tick of cooldown. Idempotent at zero. */
export function tickCooldown(state: SelfHealState): SelfHealState {
  if (state.cooldownTicks <= 0) return state;
  return { ...state, cooldownTicks: state.cooldownTicks - 1 };
}

export type PassOutcome = "progress" | "idle" | "error" | "blocked";

/** What a finished backfill pass means for scheduling the next one. */
export function classifyPass(pass: { embedded: number; stoppedBecause?: string }): PassOutcome {
  switch (pass.stoppedBecause) {
    case "nothing-to-do":
      return "idle";
    case "no-model":
    case "no-chunk-corpus":
      return "blocked";
    case "error":
      return "error";
    default:
      break;
  }
  // No stop code and nothing embedded is not success. Treating it as progress
  // would schedule the next pass immediately and spin at tick rate.
  return pass.embedded > 0 ? "progress" : "idle";
}

export function cooldownFor(outcome: PassOutcome): number {
  switch (outcome) {
    case "progress":
      return 0;
    case "idle":
      return IDLE_COOLDOWN_TICKS;
    case "error":
      return ERROR_COOLDOWN_TICKS;
    case "blocked":
      return BLOCKED_COOLDOWN_TICKS;
  }
}

/**
 * State after a pass finishes. Takes no prior state deliberately: the outcome
 * fully determines what comes next, and `running` must be cleared on **every**
 * path including a throw, so there is nothing from before worth carrying.
 */
export function afterPass(outcome: PassOutcome): SelfHealState {
  return { cooldownTicks: cooldownFor(outcome), running: false };
}
