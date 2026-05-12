import { mutateConfig, readConfig } from "../config";

/**
 * Suppress-state IO for the /memory/triage page. Keeps the "Keep for N days"
 * map in .minder.json (chosen over a sidecar JSON because it lives with the
 * rest of the dashboard config, survives memory-dir moves, and the user can
 * eyeball/edit it directly — same shape as `statuses`, `hidden`, `pinnedSlugs`).
 */

const DEFAULT_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

/** Returns a defensive shallow copy so callers can't mutate the cached config. */
export async function getSuppressMap(): Promise<Record<string, string>> {
  const cfg = await readConfig();
  return { ...(cfg.memoryTriage?.suppressUntil ?? {}) };
}

/**
 * Set "do not surface this memory in triage until now + days". Locks the
 * full r/m/w cycle via mutateConfig so concurrent suppress + clear calls
 * can't clobber each other.
 */
export async function setSuppress(
  absPath: string,
  days: number = DEFAULT_KEEP_DAYS,
  now: number = Date.now(),
): Promise<string> {
  if (!absPath) throw new Error("absPath is required");
  // Defense-at-the-data-layer: a non-finite value from the route layer would
  // otherwise produce an "Invalid Date" ISO that breaks every subsequent
  // suppress-map read. Fall back to the default rather than throw.
  const dayCount = Number.isFinite(days) ? Math.floor(days) : DEFAULT_KEEP_DAYS;
  const safeDays = Math.max(1, dayCount);
  const until = new Date(now + safeDays * DAY_MS).toISOString();
  await mutateConfig((cfg) => {
    if (!cfg.memoryTriage) cfg.memoryTriage = { suppressUntil: {} };
    if (!cfg.memoryTriage.suppressUntil) cfg.memoryTriage.suppressUntil = {};
    cfg.memoryTriage.suppressUntil[absPath] = until;
  });
  return until;
}

/** Lift the suppression for one memory file. No-op if it wasn't set. */
export async function clearSuppress(absPath: string): Promise<void> {
  if (!absPath) return;
  await mutateConfig((cfg) => {
    if (!cfg.memoryTriage?.suppressUntil) return;
    delete cfg.memoryTriage.suppressUntil[absPath];
  });
}
