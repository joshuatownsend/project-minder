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

/**
 * What one cycle found: the capped detail, and how many there really were.
 *
 * `total` is separate because the cap discards detail, not evidence. Beyond it,
 * dropping the extras silently made the header and the banner claim exactly 50
 * locations failed when hundreds had — which understates a broad fault at
 * precisely the moment it is most worth knowing about (Codex P2, PR #527).
 */
interface CycleResult {
  items: SweepFailure[];
  total: number;
}

const globalForSweep = globalThis as unknown as {
  /** What the last COMPLETED cycle of each sweep found. Read by the API. */
  __minderSweepPublished?: Map<SweepName, CycleResult>;
  /** What the cycle currently running has found so far. Not yet visible. */
  __minderSweepPending?: Map<SweepName, CycleResult>;
  /**
   * How many cycles are open per sweep.
   *
   * Two overlapping callers of the same sweep are possible — `getStatsInputs`
   * has no in-flight slot, so two file-backend stats requests can run
   * `scanClaudeConversationsForProjects` concurrently. Without this the second
   * `begin` reset the first's partial list and the first `end` published a
   * half-finished result as though it were whole (Codex P2, PR #527).
   *
   * Depth-counted rather than token-based: the outermost cycle owns the
   * publish, which is the behaviour both callers want and neither has to know
   * about.
   */
  __minderSweepDepth?: Map<SweepName, number>;
};

function published(): Map<SweepName, CycleResult> {
  if (!globalForSweep.__minderSweepPublished) {
    globalForSweep.__minderSweepPublished = new Map();
  }
  return globalForSweep.__minderSweepPublished;
}

function pending(): Map<SweepName, CycleResult> {
  if (!globalForSweep.__minderSweepPending) {
    globalForSweep.__minderSweepPending = new Map();
  }
  return globalForSweep.__minderSweepPending;
}

function depth(): Map<SweepName, number> {
  if (!globalForSweep.__minderSweepDepth) {
    globalForSweep.__minderSweepDepth = new Map();
  }
  return globalForSweep.__minderSweepDepth;
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
  const d = (depth().get(sweep) ?? 0) + 1;
  depth().set(sweep, d);
  // Only the OUTERMOST cycle resets. An overlapping caller joins the one in
  // flight rather than restarting it.
  if (d === 1) pending().set(sweep, { items: [], total: 0 });
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
  const d = depth().get(sweep) ?? 0;
  if (d === 0) return; // no cycle was started; leave the last result alone
  const next = d - 1;
  depth().set(sweep, next);
  // The innermost caller finishing does not publish — the sweep is still
  // running for whoever opened it first.
  if (next > 0) return;
  const found = pending().get(sweep);
  if (!found) return;
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
  const result = pending().get(failure.sweep);
  if (!result) {
    // No cycle started — a sweep that records without `beginSweepFailureCycle`
    // is a wiring bug, and silently starting one here would hide it while
    // letting entries accumulate across passes forever.
    return;
  }
  // Counted ALWAYS, kept only up to the cap. The cap bounds memory and what a
  // banner can render; it must not bound what the count reports.
  result.total++;
  if (result.items.length >= MAX_PER_SWEEP) return;
  result.items.push(failure);
}

/** The capped detail from the most recent COMPLETED cycle of each sweep. */
export function getSweepFailures(): SweepFailure[] {
  const out: SweepFailure[] = [];
  for (const r of published().values()) out.push(...r.items);
  return out;
}

/**
 * How many failures there actually were, including any past the detail cap.
 *
 * Separate from `getSweepFailures().length` on purpose: a broad fault is
 * exactly the case where the two differ, and reporting the capped length as
 * the count would understate it precisely when it matters.
 */
export function getSweepFailureTotal(): number {
  let total = 0;
  for (const r of published().values()) total += r.total;
  return total;
}

/**
 * Discard everything.
 *
 * Tests, and — importantly — a CONFIG CHANGE. Removing an unreadable extra
 * home should stop it being reported, and nothing else clears the record: the
 * next sweep would simply not re-record it, but until that sweep finishes the
 * homes endpoint keeps naming a path the user has already dealt with
 * (Codex P2, PR #527).
 */
export function clearSweepFailures(): void {
  globalForSweep.__minderSweepPublished = undefined;
  globalForSweep.__minderSweepPending = undefined;
  globalForSweep.__minderSweepDepth = undefined;
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
