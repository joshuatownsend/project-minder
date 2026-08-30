import "server-only";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { partitionClaudeHomes } from "@/lib/claudeHome";
import { demoMode } from "@/lib/demo/demoMode";
import {
  getSweepFailures,
  getSweepFailureTotal,
  describeSweepFailure,
} from "@/lib/sweepFailures";

export const dynamic = "force-dynamic";

/**
 * GET /api/claude-homes
 *
 * Which configured Claude homes can be read right now, and which cannot.
 *
 * Exists so the UI can say "one home unavailable" instead of Minder deciding
 * silently for the user (#479). A home inside a stopped WSL distro is excluded
 * from every read — deliberately, because touching it would auto-start the VM
 * (the never-wake invariant, #307/#308) — and that exclusion was invisible:
 * file-parse answers over readable homes only, while SQLite retains rows
 * indexed when that home was last up, so totals quietly disagree with
 * themselves and nothing says why.
 *
 * Cheap enough to poll: `checkWslRoot` shells `wsl.exe --list` behind its own
 * cache, and the whole answer is a handful of strings. It does NOT touch any
 * home's filesystem, which is the entire point.
 */
export async function GET(): Promise<NextResponse> {
  // Demo mode never reads the real homes (Codex P1, PR #510). Both arrays
  // carry ABSOLUTE host paths — the machine username, where the user keeps
  // their Claude homes, and the names of their WSL distros — and the banner
  // renders an unavailable one verbatim. Every other path-bearing route
  // substitutes synthetic data here; this one has nothing to substitute, so it
  // reports full coverage of nothing, which is the honest demo answer: a demo
  // machine has no unreadable homes to warn about.
  //
  // Before `readConfig`, not after: the point is not to filter the paths out of
  // the response but never to look at them, and never to spend a `wsl.exe` or
  // UNC probe on a viewer's behalf.
  if (await demoMode()) {
    // Carries the header too. It is part of the endpoint's contract and the
    // help page says every response has it, so omitting it would leave a
    // header-only client with an indeterminate answer in exactly the
    // deployment where it cannot fall back to reading paths out of the body.
    // (Codex P2, PR #510.)
    const demo = NextResponse.json({
      readable: [],
      unavailable: [],
      degraded: [],
      degradedTotal: 0,
      complete: true,
    });
    demo.headers.set("X-Minder-Homes-Unavailable", "0");
    // The new header too. Demo mode's whole contract here is that the SHAPE is
    // invariant, so a header-only client gets a determinate answer rather than
    // an absent one — the reason the count above is set at all (Codex P2,
    // PR #527).
    demo.headers.set("X-Minder-Sweep-Degraded", "0");
    return demo;
  }

  const config = await readConfig();
  const { readable, unavailable } = await partitionClaudeHomes(config);

  // #513: enumeration failures the SWEEPS hit, rather than a second opinion
  // about readability. `unavailable` is the never-wake exclusion — a decision
  // made BEFORE reading — and it is the only kind #479 could report. Everything
  // else that shrinks the corpus (a disconnected drive, a moved home, changed
  // permissions, a `projects` path that is a file, one project directory with a
  // restrictive ACL) shows up only as a failed `readdir` inside a reader, and
  // those were caught and discarded.
  //
  // These are what was ACTUALLY read, so they cannot disagree with the corpus
  // the way an independent probe would — which is what PR #510 spent five
  // rounds establishing before the probe was withdrawn.
  // The TRUE count, which can exceed the detail list: the cap bounds what a
  // banner can render, not what is reported (Codex P2, PR #527).
  const degradedTotal = getSweepFailureTotal();

  /**
   * The DB reconcile's own verdict on the last full pass (#529).
   *
   * The two sweeps above are FILE readers. With `MINDER_USE_DB=1` — the default
   * — a session-list or stats request need never run either of them, because
   * `src/lib/data/index.ts` answers from the index. So after a startup with a
   * clean in-process collector this route reported `complete: true` while the
   * latest index pass had explicitly marked itself incomplete and may have been
   * serving stale rows.
   *
   * `null` covers every "no claim" case — DB disabled or unavailable, no full
   * pass yet, or a verdict about a corpus the config has since changed — and
   * none of them may read as a fault. A machine before its first index is not
   * degraded, which is the same rule the file sweeps follow.
   *
   * `probeInitStatus` rather than `initDb`: routes must not drive DB init
   * themselves, or they bypass the retry/classification the façade owns.
   */
  let reconcileIncomplete = false;
  let reconcileFailures = 0;
  try {
    // Imported DYNAMICALLY, and `dbIsolationGuard.test.ts` is why. A static
    // import of this chain freezes `src/lib/db/connection.ts`'s path constant to
    // the real `~/.minder` at module load — before a test's isolation runs — so
    // any suite that imports this route would point at the developer's real
    // index. Deferring it also means the DB modules are not loaded at all unless
    // this branch runs.
    const [{ probeInitStatus }, { getDb }, { computeCorpusVersion, readReconcileVerdict }] =
      await Promise.all([
        import("@/lib/data"),
        import("@/lib/db/connection"),
        import("@/lib/db/reconcileVerdict"),
      ]);
    const init = await probeInitStatus();
    // `probeInitStatus` reports the state; `getDb` hands back the handle it
    // opened. Going through the probe first is what keeps this route out of the
    // init/retry business — it never drives a connection, it only reads one
    // that is already established.
    const db = init.state === "success" ? await getDb() : null;
    if (db) {
      const verdict = readReconcileVerdict(db, computeCorpusVersion(config));
      if (verdict?.incomplete) {
        reconcileIncomplete = true;
        reconcileFailures = verdict.enumerationFailures;
      }
    }
  } catch {
    // A completeness answer must never be the thing that takes this route down.
  }
  const degraded = getSweepFailures().map((f) => ({
    path: f.path,
    scope: f.scope,
    sweep: f.sweep,
    reason: describeSweepFailure(f),
  }));

  const response = NextResponse.json({
    readable,
    unavailable,
    /**
     * Enumerations that failed during the most recent sweep of each reader.
     * Empty until a sweep has run, which is honest: nothing has been read yet,
     * so nothing is known to have failed.
     */
    degraded,
    /**
     * How many enumerations failed in total. `degraded` is capped, so on a
     * broad fault this is larger — and that is the case where understating it
     * would matter most.
     */
    degradedTotal,
    /**
     * True when every configured home answered AND nothing failed to enumerate.
     *
     * `unavailable.length === 0` alone was the UI's one-bit question and it was
     * answering a narrower one: "no home was deliberately skipped". A corpus
     * short by a project directory nobody could list reported `complete: true`
     * (#513).
     */
    /**
     * The last full DB reconcile could not enumerate part of the corpus.
     *
     * Reported separately from `degraded` because it is a different reader with
     * a different granularity: the file sweeps name the paths they could not
     * list, while the reconcile counts its enumeration failures. Folding the
     * count into `degradedTotal` would make a client that renders those paths
     * claim to know locations it has not been given.
     */
    reconcileIncomplete,
    reconcileFailures,
    /**
     * True when every configured home answered, nothing failed to enumerate,
     * AND the last full index pass read the corpus through.
     *
     * `unavailable.length === 0` alone was the UI's one-bit question and it was
     * answering a narrower one: "no home was deliberately skipped". A corpus
     * short by a project directory nobody could list reported `complete: true`
     * (#513) — and so did one whose DB pass aborted, which is the default
     * backend and so the answer most users actually get (#529).
     */
    complete: unavailable.length === 0 && degradedTotal === 0 && !reconcileIncomplete,
  });
  // Same convention as `X-Minder-Backend`: the fact rides a header too, so a
  // client that only cares whether coverage is whole does not have to parse
  // the body.
  response.headers.set(
    "X-Minder-Homes-Unavailable",
    String(unavailable.length),
  );
  // Its own header rather than folded into the count above: that one counts
  // HOMES deliberately skipped, and a failed project-directory listing is
  // neither a home nor deliberate. Merging them would make a client that
  // watches the existing header start reporting "homes unavailable" for a
  // permissions problem two levels down.
  response.headers.set("X-Minder-Sweep-Degraded", String(degradedTotal));
  return response;
}
