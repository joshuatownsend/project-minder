import { promises as fsPromises } from "fs";
import { normalizePathKey } from "@/lib/platform";
import { homeDedupeKey, getPrimaryClaudeHome } from "@/lib/claudeHome";

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
 * Each sweep replaces its own entries when it FINISHES, so the list always
 * describes the most recent completed pass rather than accumulating a history
 * of transient faults. A home that failed an hour ago and has since recovered
 * must not still be reported as degraded.
 *
 * On finishing, not on starting, and the distinction is load-bearing: a cycle
 * collects into a pending list while the previous published result stays
 * readable, so a poll landing mid-sweep sees the last complete answer rather
 * than an empty one that reads as "all clear" and then flickers back. An
 * earlier version of this paragraph said "clears its own entries when it
 * starts", which describes exactly the behaviour the tests now guard against.
 * (Copilot, PR #527.)
 *
 * On `globalThis` for the usual reason: the sweeps run on their own schedules
 * across HMR module reloads, and a fresh module instance holding an empty list
 * would report "nothing wrong" for a corpus that is still short.
 */

/** Which enumeration failed. The banner says different things for each. */
export type SweepFailureScope =
  /**
   * `<home>/projects` could not be listed.
   *
   * NOT "the whole home is missing", which is only one of the causes and the
   * least likely to be the one a reader is looking at: permissions on the
   * directory, a `projects` path that is a plain file, a link pointing at a
   * drive that is not connected, or an I/O error all land here too. Naming one
   * cause in the type sends someone troubleshooting the wrong thing —
   * `describeSweepFailure` exists precisely because the errno is what
   * distinguishes them. (Copilot, PR #527.)
   */
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
   * Failures counted past `MAX_TRACKED_KEYS`, attributed to the home they sat
   * under.
   *
   * Past the tracking cap a cycle stops keeping keys, so those failures are
   * counted and then anonymous — and when their home is later removed from the
   * configuration, `forgetSweepFailuresUnder` had nothing to subtract. A home
   * that had blown the cap went on contributing hundreds of "unreadable
   * locations" to the banner after it had left the swept set.
   * (Codex P2, PR #527.)
   *
   * One counter per HOME, not per path: the whole point is that the paths are
   * no longer retained, and a home's `<home>/projects` prefix is recoverable
   * from any failure beneath it.
   */
  overflowByHome: Map<string, number>;
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
      overflowByHome: new Map(),
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
export function endSweepFailureCycle(sweep: SweepName, token: number): void {
  // A caller whose generation has been superseded touches NOTHING — not the
  // depth counter, not the pending result. It was invalidated by a config
  // change mid-sweep, and whatever is in flight now belongs to the replacement
  // sweep that started afterwards. Decrementing the depth here is how the old
  // caller used to publish the new cycle's half-finished result as final.
  if (token !== generation()) return;
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
  // A cycle retires its OWN superseded failures before publishing, not only
  // other sweeps'.
  //
  // Two `scanAllSessions()` calls can overlap and share one pending result, so
  // within a single cycle a path can fail and then be listed successfully. The
  // published result kept the failure — `retireVerified` deliberately skips the
  // publishing sweep, since that result was just written — and the banner went
  // on naming a directory the newest observation had read fine.
  //
  // The same observation ordering decides it, so a success only clears a
  // failure it actually postdates. (Codex P2, PR #527.)
  published().set(sweep, prunePublished(found, found.verified));
  pending().delete(sweep);
  retireVerified(sweep, found.verified);
}

/**
 * Drop `projects-dir` entries a later success in `verified` supersedes.
 *
 * Shared by the publishing path and `retireVerified` so a cycle's own result
 * and every other sweep's are pruned by exactly the same rule — the two used to
 * differ, and the difference was invisible until a shared cycle produced it.
 */
function prunePublished(result: CycleResult, verified: Map<string, number>): CycleResult {
  if (verified.size === 0) return result;

  const supersededKey = (key: string, observedAt: number): boolean => {
    if (!key.startsWith("projects-dir|")) return false;
    const okAt = verified.get(key.slice("projects-dir|".length));
    return okAt !== undefined && okAt > observedAt;
  };

  const seen = new Map(result.seen);
  let removed = 0;
  for (const [key, observedAt] of result.seen) {
    if (supersededKey(key, observedAt)) {
      seen.delete(key);
      removed++;
    }
  }

  const items = result.items.filter((f) => {
    const key = sweepFailureKey(f);
    const observedAt = result.seen.get(key);
    return observedAt === undefined || !supersededKey(key, observedAt);
  });

  if (removed === 0 && items.length === result.items.length) return result;
  return {
    ...result,
    items,
    seen,
    total: Math.max(items.length, result.total - removed),
  };
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
  const supersedes = (rawPath: string, observedAt: number | undefined): boolean => {
    const okAt = verified.get(normalizePathKey(rawPath));
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
      // Already canonical — `sweepFailureKey` built it — so it is compared
      // against `verified` directly rather than normalized a second time.
      const canonical = key.startsWith("projects-dir|")
        ? key.slice("projects-dir|".length)
        : null;
      const okAt = canonical === null ? undefined : verified.get(canonical);
      if (okAt !== undefined && observedAt !== undefined && okAt > observedAt) {
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
  token: number
): void {
  if (token !== generation()) return;
  // Canonical, so a success recorded under one spelling retires a failure
  // recorded under another — the same key space `sweepFailureKey` uses.
  pending().get(sweep)?.verified.set(normalizePathKey(projectsDir), observedAt());
}

/**
 * Record one failed enumeration.
 *
 * Bounds the DETAIL only — never the count (`getSweepFailureTotal` reads the
 * keys, which outlive it). A tree with thousands of unreadable project
 * directories would otherwise turn a diagnostic into a memory leak, and the
 * banner cannot render a thousand rows anyway; past the first handful, the
 * count is what a reader needs.
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

/**
 * The `<home>/projects` prefix a failure path sits under, canonically.
 *
 * Both scopes share the shape — a `projects-dir` failure IS that path and a
 * `project-dir` failure sits beneath it — so one slice recovers the owner of
 * either. Returns null for a path matching neither, which is not a shape the
 * sweeps produce but must not throw if one ever does.
 */
function homeProjectsPrefix(rawPath: string): string | null {
  const key = normalizePathKey(rawPath);
  const at = key.lastIndexOf("/projects");
  if (at < 0) return null;
  return key.slice(0, at + "/projects".length);
}

/**
 * One location, however many sweeps trip over it — and however it is spelled.
 *
 * Built in `normalizePathKey`'s space, which is the project's existing answer
 * to "are these the same path": it normalizes separators, collapses the
 * `wsl$` / `wsl.localhost` aliases, and folds case ONLY on Windows (on POSIX
 * `/data/Claude` and `/data/claude` are genuinely different directories).
 *
 * The raw path stays on the failure for display; only the KEY is canonical.
 *
 * A first version of this compared raw strings, and a second hand-rolled
 * `toLowerCase()` with `path.sep`. Both were the same mistake — approximating
 * a predicate that already exists — and it produced three separate defects:
 * duplicate counts for one directory across two WSL spellings, a success under
 * one spelling failing to retire a failure under the other, and a removed home
 * saved with forward slashes failing to prune its own entries.
 * (Codex P2 x2 + Copilot, PR #527.)
 */
/**
 * Is a failed `readdir` of `<home>/projects` a benign absence rather than lost
 * coverage?
 *
 * ONE implementation, called by every sweep, because the drift is the bug. #513
 * taught the two file sweeps three distinctions; the DB reconcile — which is the
 * DEFAULT backend — kept a bare `code === "ENOENT"` and therefore recorded a
 * dangling `projects` symlink as a clean pass (#529, findings 4 and 5). Two
 * copies of a rule this subtle will always end up disagreeing, and the one that
 * disagrees silently is the one that ships.
 *
 * Benign means one of exactly two things:
 *
 *   - the home is there and simply has no `projects/` yet — every machine
 *     before its first session;
 *   - it is the IMPLICIT primary (`~/.claude`) and has never been created —
 *     valid on a machine that only ever ran Codex or Gemini, since the primary
 *     is swept whether or not it exists.
 *
 * Everything else is a gap the sweep was expected to read:
 *
 *   - `projects/` must be absent as an ENTRY, not merely unreadable. A symlink
 *     pointing at a disconnected drive gives ENOENT from `readdir` while the
 *     home sits right there, and `lstat` is what sees the difference — the one
 *     case a user most needs told about.
 *   - the implicit-primary exemption needs `lstat` on the HOME too: if
 *     `~/.claude` is itself a link to a disconnected drive, `directoryExists`
 *     follows the broken link and reads false, and the exemption would fire
 *     while ALL Claude history was unavailable.
 *   - a CONFIGURED home going missing is history the sweep was expected to
 *     read, so it is never exempt.
 *
 * `home` is `null` when the caller was handed an explicit `projectsDir` rather
 * than discovering one under a home — `reconcileAllSessions({ projectsDir })`,
 * and the tests that drive it. There is no configured home to have gone
 * missing in that case, so the home half of the rule has nothing to say and is
 * skipped; the ENTRY check still applies, because a dangling link is a dangling
 * link however the path arrived. Getting this wrong marks every pass aborted
 * for a caller that simply pointed at a directory that is not there — the #471
 * regression, which `dbIndexerRuns.test.ts` pins.
 */
export async function isBenignAbsentProjectsDir(
  home: string | null,
  projectsDir: string,
  code: string | undefined
): Promise<boolean> {
  if (code !== "ENOENT") return false;
  if (home !== null) {
    const homeExists = await directoryExists(home);
    const isImplicitPrimary = homeDedupeKey(home) === homeDedupeKey(getPrimaryClaudeHome());
    const primaryNeverCreated = isImplicitPrimary && !(await pathEntryExists(home));
    if (!homeExists && !primaryNeverCreated) return false;
  }
  return !(await pathEntryExists(projectsDir));
}

export function sweepFailureKey(failure: SweepFailure): string {
  return `${failure.scope}|${normalizePathKey(failure.path)}`;
}

export function recordSweepFailure(failure: SweepFailure, token: number): void {
  // A caller invalidated by a mid-sweep `clearSweepFailures()` must not write
  // into the replacement cycle either. Guarding only `end` was half a fix: the
  // stale sweep goes on running and goes on finding failures, and those landed
  // in the new cycle's pending result by sweep NAME — so paths from the old
  // configuration were published by the replacement, which is the very thing
  // the generation check was added to stop. (Codex P2, PR #527.)
  if (token !== generation()) return;
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
  if (result.seen.has(key)) {
    // Deduplicated, but RE-STAMPED and REPLACED.
    //
    // Re-stamped because three overlapping callers sharing one cycle can
    // observe a directory as failure -> success -> failure, and keeping the
    // first failure's timestamp made the intermediate success look newer than
    // the last observation — so `prunePublished` retired a failure that was
    // still true and the endpoint reported complete.
    //
    // Replaced because the ERRNO can change between those observations, and it
    // is the actionable half of the message: a later `ENOTDIR` displayed as the
    // earlier `EACCES` sends the user to fix permissions on a path that is
    // actually a file. `getSweepFailures` was taught to prefer the newest
    // detail ACROSS sweeps and this left the same defect WITHIN one cycle.
    //
    // The location is still counted once; only what is said about it, and when
    // it was last seen failing, move. (Codex P2 x2, PR #527.)
    result.seen.set(key, observedAt());
    const at = result.items.findIndex((f) => sweepFailureKey(f) === key);
    if (at >= 0) result.items[at] = failure;
    return;
  }
  // Stamped with WHEN it was observed. The sweeps overlap — `sessions` can list
  // a directory successfully and stay busy while `usage` then fails on that
  // same path — so retirement has to compare observations rather than assume
  // the publishing cycle saw the world last. (Codex P2, PR #527.)
  if (result.seen.size < MAX_TRACKED_KEYS) {
    result.seen.set(key, observedAt());
  } else {
    // Past the tracking cap the key is not kept, so this count would otherwise
    // be anonymous — and an unattributable count cannot be retired when its
    // home leaves the configuration. (Codex P2, PR #527.)
    const owner = homeProjectsPrefix(failure.path);
    if (owner) {
      result.overflowByHome.set(owner, (result.overflowByHome.get(owner) ?? 0) + 1);
    }
  }
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
  // Deduplicated by location, keeping the NEWEST observation of it.
  //
  // Insertion order kept whichever sweep's result happened to be iterated
  // first, so an older `EACCES` masked a later `ENOTDIR` for the same path and
  // the banner went on advising the user about permissions after the cause had
  // changed. The errno is the actionable half of the message — `EACCES` and
  // `ENOTDIR` send someone to do completely different things — so "which of the
  // two" is not a cosmetic choice. (Codex P2, PR #527.)
  //
  // An entry with no recorded timestamp (past the tracking cap, so its key was
  // never kept) sorts oldest: it loses to anything stamped, and among
  // themselves the first wins, which is the previous behaviour for exactly the
  // entries this cannot do better for.
  const best = new Map<string, { failure: SweepFailure; at: number }>();
  for (const r of published().values()) {
    for (const f of r.items) {
      const key = sweepFailureKey(f);
      const at = r.seen.get(key) ?? -1;
      const existing = best.get(key);
      if (existing === undefined || at > existing.at) best.set(key, { failure: f, at });
    }
  }
  // Capped AFTER merging, newest first.
  //
  // `MAX_PER_SWEEP` bounds what each cycle retains, so two sweeps could hand
  // back 100 distinct locations between them — while the API contract, the
  // banner, and this module's own docs all say the detail is bounded at 50 with
  // `degradedTotal` carrying the uncapped count. The cap has to apply where the
  // lists are merged, or it is not a cap on what a caller receives.
  // (Copilot, PR #527.)
  //
  // Newest first so the entries that survive the cut are the ones describing
  // the corpus as it is now — the same reason the deduplication above prefers
  // the newest observation.
  return [...best.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PER_SWEEP)
    .map((e) => e.failure);
}

/**
 * How many distinct LOCATIONS failed, across every sweep.
 *
 * Two caps sit behind this and they do different jobs, which the earlier
 * "including any past the detail cap" phrasing flattened into one:
 *
 *   - `MAX_PER_SWEEP` (50) bounds the DETAIL a cycle retains. It does not bound
 *     this count at all — the keys outlive the detail, and deduplicating them
 *     across sweeps is what makes one broken directory found by both sweeps
 *     count once.
 *   - `MAX_TRACKED_KEYS` (2,000) bounds the KEYS. Only past that does a cycle
 *     lose the ability to deduplicate, and what it counted beyond it is added
 *     per cycle — so a fault broad enough to blow 2,000 keys in two sweeps at
 *     once can still overstate. That direction is deliberate: this figure
 *     exists to tell a user their corpus is incomplete, and the failure that
 *     matters is understating it.
 *
 * Separate from `getSweepFailures().length` on purpose: a broad fault is
 * exactly the case where the two differ, and reporting the capped detail
 * length as the count would understate it precisely when it matters.
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
 * Forget the diagnostics for homes that have LEFT the swept set.
 *
 * `clearSweepFailures` wipes everything, and for a config change that is too
 * blunt: with two homes configured and one still unreadable, adding or removing
 * an unrelated third erased the surviving home's live failure as well. The
 * endpoint then reported `complete: true` until a full file sweep happened to
 * run again — which on the normal DB-backed path may be never — even though
 * nothing was ever observed recovering. (Codex P2, PR #527.)
 *
 * The generation still bumps, because a sweep in flight was enumerating the OLD
 * home set and must not publish into the new one. What changes is that the
 * PUBLISHED results are pruned rather than dropped: an entry survives unless
 * its path lies under a home that is gone.
 *
 * Prefix-matched on `<home>/projects`, which is the shape both scopes share —
 * `projects-dir` failures ARE that path and `project-dir` failures sit beneath
 * it. Compared case-insensitively because Windows paths are, and this is the
 * platform the corpus usually lives on.
 */
export function forgetSweepFailuresUnder(removedHomes: string[]): void {
  // Bumped first, and unconditionally: even with nothing to prune, a sweep
  // opened under the old configuration must not publish into the new one.
  globalForSweep.__minderSweepGeneration = generation() + 1;
  globalForSweep.__minderSweepPending = undefined;
  globalForSweep.__minderSweepDepth = undefined;

  // Canonical, like every other key in this module. A first version compared
  // raw strings and a second hand-rolled `toLowerCase()` with `path.sep`, which
  // missed a home saved with forward slashes on Windows and merged two homes
  // differing only in case on POSIX — where they are genuinely different
  // directories. `normalizePathKey` already answers both, and folds case only
  // where the filesystem does. (Codex P2 + Copilot, PR #527.)
  const prefixes = removedHomes
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => `${normalizePathKey(h).replace(/\/+$/, "")}/projects`);
  if (prefixes.length === 0) return;

  // Separator-aware, so a home named `.../claude` cannot prune entries under a
  // sibling `.../claude-backup`.
  const under = (rawPath: string): boolean => {
    const key = normalizePathKey(rawPath);
    return prefixes.some((pre) => key === pre || key.startsWith(pre + "/"));
  };

  for (const [name, result] of published()) {
    const kept = result.items.filter((f) => !under(f.path));
    const seen = new Map(result.seen);
    let removed = 0;
    for (const key of result.seen.keys()) {
      // The key's path half is already canonical (`sweepFailureKey` built it),
      // and `under` normalizes idempotently, so passing it through is safe.
      const idx = key.indexOf("|");
      if (idx >= 0 && under(key.slice(idx + 1))) {
        seen.delete(key);
        removed++;
      }
    }

    // The UNTRACKED remainder goes too. A home that blew the 2,000-key cap
    // contributed a count with no key behind it, so subtracting only `seen`
    // entries left hundreds of "unreadable locations" attributed to a home that
    // had already left the swept set. (Codex P2, PR #527.)
    const overflowByHome = new Map(result.overflowByHome);
    for (const [owner, n] of result.overflowByHome) {
      if (under(owner)) {
        removed += n;
        overflowByHome.delete(owner);
      }
    }

    if (removed === 0 && kept.length === result.items.length) continue;
    published().set(name, {
      ...result,
      items: kept,
      seen,
      overflowByHome,
      total: Math.max(kept.length, result.total - removed),
    });
  }
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
  // "this Claude home" was wrong, and misleadingly so: the path on a
  // `projects-dir` failure is `<home>/projects`, not the home. A reader told
  // their home could not be listed goes and checks the home — which is right
  // there and readable — and concludes the warning is spurious. (Copilot, #527.)
  const what =
    failure.scope === "projects-dir"
      ? "this Claude projects directory could not be listed"
      : "one project directory could not be listed";
  switch (failure.code) {
    case "ENOENT":
      // The plausible causes differ by SCOPE, so the guidance does too.
      //
      // A RECORDED ENOENT is never "a fresh install with no `projects/` yet" —
      // that case is deliberately silent — but what it IS depends on which
      // enumeration failed:
      //
      //   - `projects-dir`: the home is gone (moved, unmounted, a WSL distro
      //     that vanished), or the `projects` entry is there and unresolvable
      //     (a link to a disconnected drive).
      //   - `project-dir`: that one directory was removed or renamed between
      //     the parent listing and this read, or the filesystem under it went
      //     away. The HOME being gone is not a plausible cause — the parent
      //     listing that produced this path had just succeeded.
      //
      // Three attempts to word this each described a strictly narrower case
      // than the code reports: "it no longer exists" (only the missing home),
      // then only the dangling link, then both — but applied to a scope where
      // neither fits. (Copilot, PR #527, three times.)
      return failure.scope === "projects-dir"
        ? `${what} — it could not be found (the home may be gone, or a link may point at a drive that is not connected)`
        : `${what} — it could not be found (it may have been removed or renamed, or the filesystem under it may be unavailable)`;
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

/**
 * Does this path exist and is it a directory?
 *
 * Used with `pathEntryExists` to disambiguate ENOENT on `<home>/projects`. A
 * fresh install has a `~/.claude` and no `projects/` until the first session is
 * written, and reporting that as degraded would put a permanent warning on
 * every new install. ENOENT counts only when the home is gone — a moved or
 * unmounted home, which is a real gap — or when the `projects` entry is there
 * and unresolvable, which is what `pathEntryExists` separates out.
 * (Codex P2 + Copilot, PR #527.)
 *
 * This docblock was stranded above `pathEntryExists` when that function was
 * inserted ahead of it, where it documented neither. Second time in this file;
 * the first was `lastFullPassWasIncomplete` at round 16. (Copilot, PR #527.)
 */
export async function directoryExists(dir: string): Promise<boolean> {
  try {
    const st = await fsPromises.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
