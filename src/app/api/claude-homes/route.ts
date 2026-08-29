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
   * The DB reconcile's own verdict on whether it read through.
   *
   * Read from the run row rather than the collector because that pass runs in
   * `workers/ingestWorker.mjs`, whose `globalThis` is isolated from this
   * process's — the same seam #478 established, and for the same reason: the
   * shared file is the only evidence both sides can see.
   *
   * `probeInitStatus` rather than `initDb`, per this repo's rule about routes
   * bypassing the retry/classification layer. A DB that is absent or still
   * warming reports nothing here: "not yet known to have failed" is honest,
   * and the file sweeps above already answer for the `MINDER_USE_DB=0` case.
   */
  let indexIncomplete = false;
  try {
    const { probeInitStatus } = await import("@/lib/data");
    const status = await probeInitStatus();
    if (status.state === "success") {
      const { getDb } = await import("@/lib/db/connection");
      const db = await getDb();
      if (db) {
        const { lastFullPassWasIncomplete } = await import("@/lib/db/indexerRuns");
        indexIncomplete = lastFullPassWasIncomplete(db);
      }
    }
  } catch {
    // Never let a completeness PROBE be the thing that breaks the endpoint that
    // reports completeness.
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
     * True when every configured home answered AND nothing failed to enumerate.
     *
     * `unavailable.length === 0` alone was the UI's one-bit question and it was
     * answering a narrower one: "no home was deliberately skipped". A corpus
     * short by a project directory nobody could list reported `complete: true`
     * (#513).
     */
    /**
     * How many enumerations failed in total. `degraded` is capped, so on a
     * broad fault this is larger — and that is the case where understating it
     * would matter most.
     */
    degradedTotal,
    /**
     * ...and the DB reconcile read through as well.
     *
     * That pass has its own enumeration-failure count and cannot publish it to
     * the collector — it runs in a worker whose `globalThis` is isolated from
     * this process's — so it persists the fact on its run row instead. Without
     * this term, a DB-backed setup (the default, where neither instrumented
     * file sweep need ever run) answered `complete: true` over an index pass
     * explicitly marked incomplete. (Codex P2, PR #527.)
     */
    complete: unavailable.length === 0 && degradedTotal === 0 && !indexIncomplete,
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
