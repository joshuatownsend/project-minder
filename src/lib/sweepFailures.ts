import { promises as fsPromises } from "fs";

/**
 * Enumeration failures the corpus sweeps hit, kept so they can be reported
 * instead of discarded (#513).
 *
 * ## Why this exists rather than a probe
 *
 * #479 made Minder say when a Claude home is skipped by the never-wake rule.
 * Every OTHER way a home can be unreadable stayed silent: a disconnected drive,
 * a moved home, changed permissions, a `<home>/projects` that is a regular
 * file, or a single encoded project directory with a restrictive ACL. The
 * readers catch those and carry on, so the corpus quietly shrinks while
 * `complete: true` is still reported.
 *
 * PR #510 tried an independent readability probe and spent five review rounds
 * discovering that "is this home readable" has no single depth — round 5 asked
 * for a deeper check and a shallower one at the same time. An independent probe
 * is a second implementation of what the readers already do, and it will keep
 * diverging from them.
 *
 * So this is not a probe. The sweeps already know exactly which enumerations
 * failed; they were throwing that knowledge away. Handing it back is both more
 * accurate than any probe — it IS what was read — and free, because the work
 * has already happened.
 *
 * ## Scope, and why it is per sweep
 *
 * Each sweep clears its own entries when it starts, so the list always
 * describes the most recent completed pass rather than accumulating a history
 * of transient faults. A home that failed an hour ago and has since recovered
 * must not still be reported as degraded.
 *
 * On `globalThis` for the usual reason: the sweeps run on their own schedules
 * across HMR module reloads, and a fresh module instance holding an empty list
 * would report "nothing wrong" for a corpus that is still short.
 */

/** Which enumeration failed. The banner says different things for each. */
export type SweepFailureScope =
  /** `<home>/projects` could not be listed — the whole home is missing. */
  | "projects-dir"
  /** One encoded project directory inside it could not be listed. */
  | "project-dir";

/** Which sweep hit it. Two read the same tree on different schedules. */
export type SweepName = "usage" | "sessions";

export interface SweepFailure {
  /** The directory that could not be enumerated. */
  path: string;
  scope: SweepFailureScope;
  /** The errno, when the failure carried one — `EACCES`, `ENOTDIR`, `EIO`. */
  code?: string;
  sweep: SweepName;
}

const globalForSweep = globalThis as unknown as {
  /** What the last COMPLETED cycle of each sweep found. Read by the API. */
  __minderSweepPublished?: Map<SweepName, SweepFailure[]>;
  /** What the cycle currently running has found so far. Not yet visible. */
  __minderSweepPending?: Map<SweepName, SweepFailure[]>;
};

function published(): Map<SweepName, SweepFailure[]> {
  if (!globalForSweep.__minderSweepPublished) {
    globalForSweep.__minderSweepPublished = new Map();
  }
  return globalForSweep.__minderSweepPublished;
}

function pending(): Map<SweepName, SweepFailure[]> {
  if (!globalForSweep.__minderSweepPending) {
    globalForSweep.__minderSweepPending = new Map();
  }
  return globalForSweep.__minderSweepPending;
}

/**
 * Start a fresh cycle for one sweep.
 *
 * Collects into a PENDING list. The previously published result stays visible
 * until `endSweepFailureCycle` replaces it, because a sweep can take a while
 * and a poll landing mid-way would otherwise see an empty list — reporting
 * `complete: true` and clearing the banner for a fault that is still there,
 * then bringing it back when the sweep finishes (Codex P2, PR #527).
 */
export function beginSweepFailureCycle(sweep: SweepName): void {
  pending().set(sweep, []);
}

/**
 * Publish what this cycle found, replacing the previous result.
 *
 * Call from a `finally`. A pass that throws half way through should still
 * publish what it managed to observe — those partial findings are usually the
 * most relevant ones, since a failure severe enough to stop the sweep is
 * exactly what a reader needs to see.
 */
export function endSweepFailureCycle(sweep: SweepName): void {
  const found = pending().get(sweep);
  if (!found) return; // no cycle was started; leave the last result alone
  published().set(sweep, found);
  pending().delete(sweep);
}

/**
 * Record one failed enumeration.
 *
 * Bounded. A tree with thousands of unreadable project directories would
 * otherwise turn a diagnostic into a memory leak, and the banner cannot render
 * a thousand rows anyway — the count is what a reader needs past the first
 * handful.
 */
const MAX_PER_SWEEP = 50;

export function recordSweepFailure(failure: SweepFailure): void {
  const list = pending().get(failure.sweep);
  if (!list) {
    // No cycle started — a sweep that records without `beginSweepFailureCycle`
    // is a wiring bug, and silently starting one here would hide it while
    // letting entries accumulate across passes forever.
    return;
  }
  if (list.length >= MAX_PER_SWEEP) return;
  list.push(failure);
}

/** Everything the most recent COMPLETED cycle of each sweep found. */
export function getSweepFailures(): SweepFailure[] {
  const out: SweepFailure[] = [];
  for (const list of published().values()) out.push(...list);
  return out;
}

/** Discard everything. Tests, and a config change that invalidates the tree. */
export function clearSweepFailures(): void {
  globalForSweep.__minderSweepPublished = undefined;
  globalForSweep.__minderSweepPending = undefined;
}

/**
 * Turn an errno into something a person can act on.
 *
 * Deliberately small, and it says what to DO rather than restating the code.
 * "EACCES" tells a reader nothing they can use; "permission denied" at least
 * names the thing to change.
 */
export function describeSweepFailure(failure: SweepFailure): string {
  const what =
    failure.scope === "projects-dir"
      ? "this Claude home could not be listed"
      : "one project directory could not be listed";
  switch (failure.code) {
    case "ENOENT":
      return `${what} — it no longer exists`;
    case "EACCES":
    case "EPERM":
      return `${what} — permission denied`;
    case "ENOTDIR":
      return `${what} — the path is a file, not a directory`;
    case "EIO":
    case "EBUSY":
      return `${what} — the filesystem reported an I/O error`;
    default:
      return failure.code ? `${what} (${failure.code})` : what;
  }
}

/**
 * Does this path exist and is it a directory?
 *
 * Used to disambiguate ENOENT on `<home>/projects`. A fresh install has a
 * `~/.claude` and no `projects/` until the first session is written, and
 * reporting that as degraded would put a permanent warning on every new
 * install. ENOENT counts only when the HOME itself is gone — a moved or
 * unmounted home, which is a real gap (Codex P2 + Copilot, PR #527).
 */
export async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await fsPromises.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
