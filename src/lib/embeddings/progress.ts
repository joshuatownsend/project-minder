/**
 * Pure presentation + control logic for the embedding-coverage panel.
 *
 * Deliberately dependency-free: no `server-only`, no `fs`, no DB handle. This
 * module is imported by a `"use client"` component, and anything that pulled a
 * Node built-in at module scope here would pass typecheck and the test suite
 * and then fail the Turbopack build with `Can't resolve 'fs'`.
 *
 * The continuation policy lives here rather than in the component for a
 * blunter reason: a wrong answer from `shouldContinue` is an infinite POST
 * loop against the local server, and a component is not somewhere the test
 * suite can reach.
 */

/**
 * Measured throughput on the machine this was built on: 15.3 ms per chunk at
 * batch 32 (see `model.ts`). Used only to estimate remaining time before any
 * real pass has run — once one has, `observedMsPerChunk` supersedes it.
 */
export const MS_PER_CHUNK = 15.3;

/** The shape of `POST /api/embeddings`'s reply that this module reasons about. */
export interface BackfillPass {
  embedded: number;
  remaining: number;
  total: number;
  durationMs?: number;
  stoppedBecause?: string;
}

/**
 * Should the driver run another pass?
 *
 * Termination is guaranteed by requiring *strict forward progress* rather than
 * by capping the iteration count: a pass must have embedded something, and
 * must have left strictly fewer chunks remaining than the pass before it. A
 * server that reported `embedded > 0` while `remaining` sat still would
 * otherwise spin forever, and an arbitrary `maxPasses` backstop would hide
 * that bug instead of stopping on it.
 *
 * @param previousRemaining `remaining` from the prior pass, or null for the first.
 */
export function shouldContinue(pass: BackfillPass, previousRemaining: number | null): boolean {
  // Any early stop is terminal. "error" especially: retrying a persistent
  // failure in a tight loop is how a stuck model becomes a stuck browser.
  if (pass.stoppedBecause) return false;
  if (pass.remaining <= 0) return false;
  if (pass.embedded <= 0) return false;
  if (previousRemaining !== null && pass.remaining >= previousRemaining) return false;
  return true;
}

/** Actual ms/chunk for a pass, or null when the pass embedded nothing. */
export function observedMsPerChunk(pass: BackfillPass): number | null {
  if (!pass.durationMs || pass.embedded <= 0) return null;
  const rate = pass.durationMs / pass.embedded;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Coverage as a 0–100 float. Zero-total is 0%, not NaN. */
export function coveragePercent(embedded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const pct = (Math.max(0, embedded) / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Coverage for display.
 *
 * Never rounds up to "100%" while chunks remain — a progress readout that
 * claims completion with work outstanding is the kind of small lie that makes
 * someone stop trusting the whole panel.
 */
export function formatPercent(embedded: number, total: number): string {
  if (total > 0 && embedded >= total) return "100%";
  const pct = coveragePercent(embedded, total);
  if (pct >= 99) return "99%";
  return `${Math.round(pct)}%`;
}

/** Rough wall-clock estimate for the chunks still unembedded. */
export function formatEta(remainingChunks: number, msPerChunk: number = MS_PER_CHUNK): string {
  if (remainingChunks <= 0) return "complete";
  const rate = Number.isFinite(msPerChunk) && msPerChunk > 0 ? msPerChunk : MS_PER_CHUNK;
  const minutes = (remainingChunks * rate) / 60_000;
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `about ${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/** Thousands separators without pulling in a formatting dependency. */
export function formatCount(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/**
 * How the embedding runtime is doing, as three distinct states.
 *
 * The API reports `available` (is the model loaded *right now*) and `reason`
 * (why it failed, if it did). Those collapse into one boolean at the UI layer
 * and lose the difference between "nobody has asked for it yet" — the normal
 * state after every server restart — and "it is broken". Only the second
 * deserves an error treatment.
 */
export type RuntimeState = "ready" | "not-loaded" | "failed";

export function runtimeState(available: boolean, reason: string | null | undefined): RuntimeState {
  if (reason) return "failed";
  return available ? "ready" : "not-loaded";
}
