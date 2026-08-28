/**
 * The harness Minder always reads, whatever `enabledAdapters` says (#491).
 *
 * `enabledAdapters` enables ADDITIONAL harnesses; it is not a source filter.
 * That has always been the behaviour on both backends — `buildAllSessions`
 * sweeps every readable Claude home before it consults the registry, and
 * `reconcileAllSessions` walks the Claude projects dirs unconditionally, with
 * its adapter discovery explicitly defined as "everything except Claude". The
 * setting could nonetheless EXPRESS the other thing, and the app quietly did
 * not honour it: unchecking Claude changed nothing anywhere, on either backend.
 *
 * Rather than build the source filter — a much larger change, since the
 * sessions list, `getClaudeUsage` (whose whole subject is Claude), the stats
 * page, the scanner's per-project session data and the detail routes would all
 * have to honour it in BOTH backends at once, plus a decision about Claude rows
 * already in the index — the setting is now unable to express it.
 *
 * Normalising through one shared rule, rather than only in the UI or only at
 * the API, is what makes a hand-edited `.minder.json` get the same answer as
 * the toggle.
 *
 * **This file must stay a leaf.** `AdaptersSection` is a `"use client"`
 * component, and importing the registry from it would pull `fs` into the client
 * bundle — the class of breakage that shipped CI red on PR #324, and one that
 * typecheck and the test suite are both structurally unable to see.
 */
export const SUBSTRATE_ADAPTER_ID = "claude";

/**
 * `enabledAdapters` with the substrate guaranteed present, order otherwise
 * preserved. Callers that persist or display the enabled set go through this,
 * so what is stored, what is shown, and what is read all agree.
 */
export function normalizeEnabledAdapters(ids: readonly string[]): string[] {
  return ids.includes(SUBSTRATE_ADAPTER_ID)
    ? [...ids]
    : [SUBSTRATE_ADAPTER_ID, ...ids];
}
