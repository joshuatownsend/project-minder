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
/**
 * Sweeps publish independently, so a name is a CORPUS, not a caller.
 *
 * Both of these walk the WHOLE Claude tree, which is what makes them able to
 * answer "was the corpus readable". A reader that enumerates a caller-chosen
 * subset cannot, and must not open a cycle at all — see the note in
 * `scanClaudeConversationsForProjects`, where two attempts to give the scoped
 * Claude-usage scan a voice here both ended with one scan erasing another's
 * finding. (Codex P2 x2, PR #527.)
 */
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
  /**
   * Distinct `scope|path` keys seen in this cycle, so `total` counts LOCATIONS
   * rather than enumeration attempts. Bounded (see `MAX_TRACKED_KEYS`) — past
   * that the cycle stops deduping and says so by leaving keys out of the set.
   */
  seen: Map<string, number>;
  /**
   * Claude homes whose `projects` directory this cycle listed SUCCESSFULLY.
   *
   * A published failure otherwise never retires. The `sessions` sweep runs
   * during the first-reconcile / file fallback and then normal DB-backed
   * requests never call it again — so a directory it found unreadable stays
   * named in the banner after the drive is reconnected, until a config change
   * or a process restart. Meanwhile the `usage` sweep, which walks the SAME
   * tree, has been listing that directory cleanly all along. (Codex P2, PR
   * #527.)
   *
   * Recorded for `projects-dir` only, deliberately. There is one per Claude
   * home, so the set is tiny and bounded — where the per-project directories
   * number in the thousands and tracking every success would turn a diagnostic
   * back into the memory leak the detail cap exists to prevent. It is also the
   * scope that actually goes stale: a home-level failure is the disconnected
   * drive, and that is the one a user fixes and then expects to stop hearing
   * about.
   */
  verified: Map<string, number>;
  /**
   * The generation this cycle was opened under. A `clearSweepFailures()` — a
   * corpus-configuration change — bumps the generation, so a sweep still
   * running from before the change can be told apart from the replacement that
   * started after it. Without this the old caller's `end` decremented the NEW
   * cycle's depth to zero and published its half-finished result as final,
   * exposing paths from the old configuration and dropping everything the
   * replacement found afterwards. (Codex P2, PR #527.)
   */
  gen: number;
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
  /** Bumped by `clearSweepFailures`; see `CycleResult.gen`. */
  __minderSweepGeneration?: number;
  /** Strictly increasing observation counter; see `observedAt`. */
  __minderSweepClock?: number;
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

/**
 * A strictly increasing stamp for "when was this observed".
 *
 * A counter rather than `Date.now()`, and not for precision — for TIES.
 * Retirement asks whether a success came after a failure, and two events in the
 * same millisecond are indistinguishable by wall clock: `>` then refuses to
 * retire a genuine recovery, and `>=` retires a genuine new failure. Both are
 * wrong, and which one bites depends on how fast the machine is. A counter has
 * no ties, so the question always has a real answer.
 *
 * Never reset — not by `clearSweepFailures`, deliberately. A published result
 * outlives a clear, so restarting the count could make a new observation
 * compare as older than one already recorded.
 */
function observedAt(): number {
  const next = (globalForSweep.__minderSweepClock ?? 0) + 1;
  globalForSweep.__minderSweepClock = next;
  return next;
}

function generation(): number {
  return globalForSweep.__minderSweepGeneration ?? 0;
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
export function beginSweepFailureCycle(sweep: SweepName): number {
  const gen = generation();
  const d = (depth().get(sweep) ?? 0) + 1;
  depth().set(sweep, d);
  // Only the OUTERMOST cycle resets. An overlapping caller joins the one in
  // flight rather than restarting it.
  if (d === 1)
    pending().set(sweep, {
      items: [],
      total: 0,
      seen: new Map(),
      verified: new Map(),
      gen,
    });
  return gen;
}

/**
 * Publish what this cycle found, replacing the previous result.
 *
 * Call from a `finally`. A pass that throws half way through should still
 * publish what it managed to observe — those partial findings are usually the
 * most relevant ones, since a failure severe enough to stop the sweep is
 * exactly what a reader needs to see.
 */
export function endSweepFailureCycle(sweep: SweepName, token?: number): void {
  // A caller whose generation has been superseded touches NOTHING — not the
  // depth counter, not the pending result. It was invalidated by a config
  // change mid-sweep, and whatever is in flight now belongs to the replacement
  // sweep that started afterwards. Decrementing the depth here is how the old
  // caller used to publish the new cycle's half-finished result as final.
  if (token !== undefined && token !== generation()) return;
  const d = depth().get(sweep) ?? 0;
  if (d === 0) return; // no cycle was started; leave the last result alone
  const next = d - 1;
  depth().set(sweep, next);
  // The innermost caller finishing does not publish — the sweep is still
  // running for whoever opened it first.
  if (next > 0) return;
  const found = pending().get(sweep);
  if (!found) return;
  // Belt and braces for a caller that passed no token: a pending cycle opened
  // before the last clear is not this generation's answer either.
  if (found.gen !== generation()) {
    pending().delete(sweep);
    return;
  }
  published().set(sweep, found);
  pending().delete(sweep);
  retireVerified(sweep, found.verified);
}

/**
 * Drop other sweeps' `projects-dir` failures for paths this cycle just read.
 *
 * Evidence, not a timer. Both full-corpus sweeps walk the same tree, so one of
 * them listing a home's `projects` directory is proof that the other's older
 * complaint about that exact path no longer holds — which is the only honest
 * way to clear a warning whose owning sweep may never run again.
 *
 * The cycle's OWN result is left alone: it was just published and already says
 * what this pass found. Only `projects-dir` entries retire, matching what
 * `verified` records; a `project-dir` failure is never verified by anything and
 * stays until its own sweep re-runs, which over-reports rather than hides a
 * gap. (Codex P2, PR #527.)
 */
function retireVerified(sweep: SweepName, verified: Map<string, number>): void {
  if (verified.size === 0) return;

  /**
   * Was this path read successfully AFTER the failure was observed?
   *
   * The two sweeps overlap, and a cycle publishes when it finishes rather than
   * when it looked. So `sessions` can list a directory at 10:00, stay busy
   * until 10:05, and in between `usage` can fail on that same path at 10:02 and
   * publish. An unconditional retirement then dropped the NEWER failure on the
   * older cycle's publish, and `/api/claude-homes` reported `complete: true`
   * over an enumeration that had just failed. (Codex P2, PR #527.)
   *
   * A `seen` entry beyond the tracking cap has no time and is treated as NOT
   * superseded — the same direction every other bound in this file fails in:
   * over-report rather than hide a gap.
   */
  const supersedes = (path: string, observedAt: number | undefined): boolean => {
    const okAt = verified.get(path);
    return okAt !== undefined && observedAt !== undefined && okAt > observedAt;
  };

  for (const [name, result] of published()) {
    if (name === sweep) continue;
    const kept = result.items.filter(
      (f) =>
        !(
          f.scope === "projects-dir" &&
          supersedes(f.path, result.seen.get(sweepFailureKey(f)))
        )
    );

    // Counted from `seen`, not from `items`, and that difference is the whole
    // point. `items` stops at the 50-entry detail cap while `seen` holds every
    // key the cycle recorded, so subtracting only the retained details left
    // `total` positive for the capped ones — with more than 50 homes down and
    // then recovered, `/api/claude-homes` stayed degraded indefinitely while
    // naming nothing. (Codex P2, PR #527.)
    const seen = new Map(result.seen);
    let retired = 0;
    for (const [key, observedAt] of result.seen) {
      const path = key.startsWith("projects-dir|") ? key.slice("projects-dir|".length) : null;
      if (path !== null && supersedes(path, observedAt)) {
        seen.delete(key);
        retired++;
      }
    }
    if (retired === 0 && kept.length === result.items.length) continue;

    published().set(name, {
      ...result,
      items: kept,
      seen,
      // Floored at the detail length so a cycle whose `seen` had been capped
      // cannot end up claiming fewer failures than it is still listing.
      total: Math.max(kept.length, result.total - retired),
    });
  }
}

/**
 * Record that a home's `projects` directory was listed successfully.
 *
 * Called by the sweeps on the success side of the same `readdir` whose failure
 * they report, so the two can never disagree about what happened.
 */
export function recordSweepSuccess(
  sweep: SweepName,
  projectsDir: string,
  token?: number
): void {
  if (token !== undefined && token !== generation()) return;
  pending().get(sweep)?.verified.set(projectsDir, observedAt());
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

/**
 * How many distinct keys one cycle will remember for deduplication.
 *
 * Higher than the detail cap on purpose — a `Set` of path strings is far
 * cheaper than the retained failure objects, and the count is the figure a
 * broad fault most distorts. Past this the cycle stops deduping rather than
 * growing without bound, which can only make the total too HIGH, never too
 * low: a diagnostic that overstates a fault is safer than one that hides it.
 */
const MAX_TRACKED_KEYS = 2000;

/** One location, however many sweeps trip over it. */
export function sweepFailureKey(failure: SweepFailure): string {
  return `${failure.scope}|${failure.path}`;
}

export function recordSweepFailure(failure: SweepFailure, token?: number): void {
  // A caller invalidated by a mid-sweep `clearSweepFailures()` must not write
  // into the replacement cycle either. Guarding only `end` was half a fix: the
  // stale sweep goes on running and goes on finding failures, and those landed
  // in the new cycle's pending result by sweep NAME — so paths from the old
  // configuration were published by the replacement, which is the very thing
  // the generation check was added to stop. (Codex P2, PR #527.)
  if (token !== undefined && token !== generation()) return;
  const result = pending().get(failure.sweep);
  if (!result) {
    // No cycle started — a sweep that records without `beginSweepFailureCycle`
    // is a wiring bug, and silently starting one here would hide it while
    // letting entries accumulate across passes forever.
    return;
  }
  // One LOCATION, not one attempt. Within a cycle a directory can be tripped
  // over more than once; across sweeps it is expected, since the usage and
  // sessions sweeps walk the same Claude tree. Counting attempts told the user
  // "2 locations could not be read" about a single broken directory, and
  // rendered its path twice. (Codex P2, PR #527.)
  const key = sweepFailureKey(failure);
  if (result.seen.has(key)) return;
  // Stamped with WHEN it was observed. The sweeps overlap — `sessions` can list
  // a directory successfully and stay busy while `usage` then fails on that
  // same path — so retirement has to compare observations rather than assume
  // the publishing cycle saw the world last. (Codex P2, PR #527.)
  if (result.seen.size < MAX_TRACKED_KEYS) result.seen.set(key, observedAt());
  // Counted ALWAYS, kept only up to the cap. The cap bounds memory and what a
  // banner can render; it must not bound what the count reports.
  result.total++;
  if (result.items.length >= MAX_PER_SWEEP) return;
  result.items.push(failure);
}

/**
 * The capped detail from the most recent COMPLETED cycle of each sweep,
 * deduplicated by location.
 *
 * Per-cycle deduplication cannot do this: the usage and sessions sweeps hold
 * separate cycles and walk the same tree, so one unreadable directory is
 * genuinely found twice. Merging happens here, where both are visible.
 */
export function getSweepFailures(): SweepFailure[] {
  const out: SweepFailure[] = [];
  const seen = new Set<string>();
  for (const r of published().values()) {
    for (const f of r.items) {
      const key = sweepFailureKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
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
  // The union of the KEYS, not the detail arrays plus a residual.
  //
  // `items` stops at 50 while `seen` tracks up to 2,000 `scope|path` keys, so
  // the earlier formula deduplicated only what was still named and added each
  // cycle's overflow blind: 60 directories that both sweeps tripped over
  // reported 70 locations, since each contributed 10 undeduplicated residuals.
  // Those residuals were deduplicable all along — the keys are right there.
  // (Codex P2, PR #527.)
  //
  // What genuinely cannot be deduplicated is what a cycle counted past its own
  // TRACKING cap, where the key was never kept. That is added per cycle and can
  // still overstate on a fault broad enough to blow 2,000 keys in two sweeps at
  // once — documented rather than hidden, and in that direction on purpose:
  // this figure exists to tell a user their corpus is incomplete, and the
  // failure that matters is understating it.
  const keys = new Set<string>();
  let beyondTracking = 0;
  for (const r of published().values()) {
    for (const key of r.seen.keys()) keys.add(key);
    beyondTracking += Math.max(0, r.total - r.seen.size);
  }
  return keys.size + beyondTracking;
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
  // Bumped LAST, and this is the half that makes the reset safe rather than
  // merely thorough: a sweep already running was opened under the old
  // generation, so from here its `end` is a no-op instead of publishing stale
  // paths over whatever the replacement sweep has found. See `CycleResult.gen`.
  globalForSweep.__minderSweepGeneration = generation() + 1;
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
/**
 * Does a directory ENTRY exist at this path — even a broken one?
 *
 * `lstat`, deliberately, and this is the whole point: `readdir` on a symlink
 * pointing at a disconnected drive or an unmounted filesystem fails with
 * ENOENT, exactly as it does on a path that was never created. Anything that
 * `stat`s (or checks the PARENT and infers) reads those two as the same thing
 * and calls the broken one healthy — which is the case the sweep-failure
 * record exists to surface (Codex P2, PR #527).
 *
 * `lstat` does not follow the link, so it succeeds on the dangling one and
 * fails only when there is genuinely nothing there.
 */
export async function pathEntryExists(target: string): Promise<boolean> {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch (err) {
    // ONLY `ENOENT` means absent. Returning false for every error made a
    // permissions or I/O failure read as "there is nothing here", which is the
    // opposite of what it means and would have skipped reporting a genuinely
    // unreadable `projects` entry — the exact case this function was added to
    // catch, and a direct contradiction of the sentence above it.
    // (Copilot, PR #527.)
    //
    // Anything else — EACCES, EIO, ELOOP, ENOTDIR on a parent — means the path
    // is THERE and could not be interrogated, so the caller must treat it as
    // present and report the failure.
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await fsPromises.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
