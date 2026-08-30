import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fsSync from "fs";
import { promises as fs } from "fs";
import { clearSweepFailures } from "@/lib/sweepFailures";

/**
 * PR #527 round 4 — four ways the failure record still lied.
 *
 * Each of these is a case where the collector reported a corpus as whole while
 * something in it was unreadable, which is the exact failure #513 exists to
 * end. Grouped in their own file because they arrived together and share the
 * temp-home fixture; the round-1..3 assertions stay in `sweepFailures.test.ts`.
 */

/**
 * Can this process create a symlink at all? On Windows that needs either
 * Developer Mode or elevation, so the dangling-symlink case is genuinely
 * unrunnable on some machines rather than merely inconvenient.
 *
 * Probed once, the same way `better-sqlite3` availability is probed elsewhere
 * in this suite, so the affected test SKIPS rather than failing for a reason
 * that has nothing to do with the code under test. It still runs on CI's Linux
 * job, so the case is covered on every push.
 */
let symlinkAvailable: boolean;
{
  let probe = "";
  try {
    probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "pm-symprobe-"));
    fsSync.symlinkSync(path.join(probe, "nowhere"), path.join(probe, "link"), "dir");
    symlinkAvailable = true;
  } catch {
    symlinkAvailable = false;
  }
  try {
    if (probe) fsSync.rmSync(probe, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sweep4-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.resetModules();
  clearSweepFailures();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  clearSweepFailures();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("a dangling `projects` symlink is not a fresh install", () => {
  it.skipIf(!symlinkAvailable)("reports it instead of calling it healthy", async () => {
    // Both produce ENOENT from `readdir` with the home sitting right there, so
    // a check that only asks "does the home exist?" reads them as the same
    // thing and calls the broken one healthy — in the one case the user most
    // needs told about (Codex P2, PR #527).
    await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
    await fs.symlink(
      path.join(tmpHome, "disconnected-drive", "projects"),
      path.join(tmpHome, ".claude", "projects"),
      "dir"
    );

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});

    const failures = getSweepFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].scope).toBe("projects-dir");
  });

  it("still says nothing about a fresh install", async () => {
    // The counterpart, and the reason the fix is `lstat` rather than "report
    // every ENOENT": a home with no `projects/` yet is every install before its
    // first session, and warning there would be a permanent banner on a machine
    // with nothing wrong with it. Kept here as well as in the round-1 file
    // because it is THIS predicate that now decides it.
    await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    expect(getSweepFailures()).toHaveLength(0);
  });
});

describe("the session-list sweep reports its own failures", () => {
  it("records an unlistable projects tree", async () => {
    // `scanAllSessions` was outside the collector entirely: its `readdir`
    // catches discarded the error and it never opened a cycle. The file backend
    // and the first-reconcile fallback both call it, so on a fresh process
    // where a session-list request meets an unreadable tree and no usage scan
    // has run, `/api/claude-homes` answered `complete: true` over a corpus that
    // was visibly short (Codex P2, PR #527).
    //
    // A FILE where `projects/` should be, rather than a permissions bit:
    // `chmod` is not meaningful on Windows and this suite runs there.
    await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".claude", "projects"), "not a directory");

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await scanAllSessions();

    const failures = getSweepFailures().filter((f) => f.sweep === "sessions");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].scope).toBe("projects-dir");
  });

  it("reports nothing when the tree reads cleanly", async () => {
    // Or the banner is permanent, which is worse than the silence it replaced.
    const dir = path.join(tmpHome, ".claude", "projects", "-home-me-dev-app");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1.jsonl"), "{}\n");

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await scanAllSessions();
    expect(getSweepFailures().filter((f) => f.sweep === "sessions")).toHaveLength(0);
  });
});

/**
 * The remaining two are source-level, and deliberately so: both are MISSING or
 * MISPLACED CALLS in modules this suite cannot execute — a Next route module
 * and a React component in a test environment with no DOM. Asserting the shape
 * of the source is a weaker check than running it, and it is the check that
 * actually discriminates for this defect class.
 */
describe("the record is cleared by corpus changes only", () => {
  it("is not cleared by every config write", async () => {
    // It started inside `invalidateAll()`, which every successful config write
    // calls — a keyboard shortcut, a port override, hiding a project. None of
    // those can change which paths get swept, so clearing there ERASED a live
    // record of an unreadable corpus and left `/api/claude-homes` answering
    // `complete: true` until whichever sweep owned it happened to run again
    // (Codex P2, PR #527, round 4).
    const { readFile } = await import("node:fs/promises");
    const route = await readFile("src/app/api/config/route.ts", "utf-8");

    const start = route.indexOf("function invalidateAll()");
    expect(start).toBeGreaterThan(-1);
    // The function body, bounded by the next top-level declaration rather than
    // a fixed character count — a fixed window is how the previous version of
    // this assertion would have kept passing as the file grew.
    const body = route.slice(start, route.indexOf("\n}", start));
    expect(body).not.toMatch(/clearSweepFailures\(\)/);

    // And it still happens, gated on the Claude home paths ACTUALLY changing.
    // `corpusShapeChanged` — where round 4 put it — was itself too wide: it
    // also fires for `pathMappings` and `enabledAdapters`, neither of which
    // changes which directories get enumerated, so clearing on them erased a
    // live diagnostic about a directory that is still unreadable.
    // (Codex P2, PR #527, round 9.)
    // The diff is COMPUTED inside the locked mutation and the collector is
    // mutated only AFTER the write commits. Both halves matter and they pull
    // in opposite directions:
    //
    //   - computing outside the lock let two overlapping PATCHes diff against
    //     the same pre-mutation config and prune each other's still-configured
    //     homes;
    //   - pruning inside it meant a request whose `writeConfig` then failed had
    //     already dropped a diagnostic for a home still configured on disk.
    const patchAt = route.indexOf("patches.push((c) => {\n      const effective");
    expect(patchAt).toBeGreaterThan(-1);
    const patchBody = route.slice(patchAt, route.indexOf("\n    });", patchAt));
    // Diffed against the LOCKED config...
    expect(patchBody).toMatch(/const before = effective\(c\);/);
    // ...and staged, not applied.
    expect(patchBody).toMatch(/pendingSweepReset = changed/);
    expect(patchBody).not.toMatch(/forgetSweepFailuresUnder\(/);
    // Applied after `mutateConfig` resolves, which is after the write.
    const mutateAt = route.indexOf("const config = await mutateConfig(");
    expect(mutateAt).toBeGreaterThan(-1);
    expect(route.indexOf("forgetSweepFailuresUnder(pendingSweepReset)")).toBeGreaterThan(
      mutateAt
    );

    // And the narrower flag is set from a COMPARISON, not from the key being
    // present. A Settings save posts every field, so `Array.isArray(body.claudeHomes)`
    // alone would clear the record on every unrelated save — the same defect
    // one level down.
    // Compared as the set of homes that would ACTUALLY BE SWEPT, by running
    // `getClaudeHomes` over both configs. Three narrower attempts each missed a
    // different way for the config to change while the swept set does not — a
    // reorder, an equivalent spelling, an entry redundant with the implicit
    // primary — and all three were the same mistake: approximating a predicate
    // that already exists. (Copilot, then Codex x2, PR #527.)
    // The comparison itself, wherever it is bound. It was a module-level
    // `claudeHomePathsChanged` until the diff moved inside the locked
    // mutation, where it became a local `changed` — a rename that preserved
    // the property, and would have broken a guard pinned to the name.
    expect(route).toMatch(/before\.size !== after\.size \|\|\s*\[\.\.\.after\.keys\(\)\]\.some/);
    // Asserts the two authorities are consulted, not the container they are
    // collected into — that became a Map when the reset needed to know WHICH
    // homes left, and pinning the literal would have broken on a change that
    // preserved the property.
    expect(route).toMatch(
      /for \(const h of getClaudeHomes\(cfg\)\) out\.set\(homeDedupeKey\(h\), h\)/
    );
  });
});

describe("the banner counts what failed, not what it kept", () => {
  it("reads degradedTotal rather than the capped detail array", async () => {
    // `degraded` is capped at 50 entries. Using its length told the user that
    // exactly 50 locations failed on a broad fault — understating it in the one
    // case where the number matters most — and this revision had already added
    // the uncapped `degradedTotal` to the API without propagating it here
    // (Codex P2, PR #527, round 4).
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/components/UnavailableHomesBanner.tsx", "utf-8");

    expect(src).toMatch(/degradedTotal/);

    // Every COUNT the user reads must come from the total. `degraded.length` is
    // still legitimate for "is there anything to show at all", so the check is
    // on the two rendered figures rather than on the identifier appearing
    // anywhere — a blanket ban would have to be relaxed the moment someone
    // added a correct use, and a check that gets relaxed stops checking.
    expect(src).toMatch(/\$\{degradedTotal\} locations could not be read/);
    expect(src).toMatch(/\$\{degradedTotal\} locations, including/);
    expect(src).not.toMatch(/\$\{degraded\.length\} locations/);
  });
});

/**
 * Round 5 — three more ways the record misdescribed the corpus.
 *
 * Behavioural, not source-level: all three are in the collector, which this
 * suite can execute directly.
 */
describe("round 5 — the collector tells the truth about what failed", () => {
  it("treats an unreadable path as PRESENT, not absent", async () => {
    // `pathEntryExists` returned false for ANY lstat error, so a permissions or
    // I/O failure read as "there is nothing here" — the opposite of what it
    // means, and a direct contradiction of the comment above it. It would have
    // skipped reporting a genuinely unreadable `projects` entry, which is the
    // one case the function was added to catch. (Copilot, PR #527.)
    //
    // The errno is INJECTED rather than provoked. Windows collapses every
    // lstat failure to ENOENT — measured here on all three of the obvious
    // candidates (a path under a file, an over-long path, a missing path) —
    // so a filesystem-provoked EACCES/ENOTDIR would exercise the distinction
    // on CI's Linux job and silently not exercise it anywhere else. A test
    // that runs everywhere and discriminates nowhere is the failure mode this
    // suite keeps finding in its own assertions.
    const { pathEntryExists } = await import("@/lib/sweepFailures");
    const { promises: realFs } = await import("fs");

    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const spy = vi.spyOn(realFs, "lstat").mockRejectedValueOnce(denied);
    expect(await pathEntryExists(path.join(tmpHome, "guarded"))).toBe(true);
    spy.mockRestore();

    // And a genuine absence still reads as absent, or every fresh install would
    // warn. Not injected — this one the filesystem produces the same way on
    // every platform.
    expect(await pathEntryExists(path.join(tmpHome, "nothing-here"))).toBe(false);
  });

  it("counts one broken directory once, however many sweeps trip over it", async () => {
    // The usage and sessions sweeps walk the same Claude tree, so a single
    // unreadable directory is genuinely found by both. Summing the cycles told
    // the user "2 locations could not be read" about one location, and rendered
    // its path twice. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const same = { path: "/home/me/.claude/projects", scope: "projects-dir" as const };

    const t1 = beginSweepFailureCycle("usage");
    recordSweepFailure({ ...same, sweep: "usage" }, t1);
    endSweepFailureCycle("usage", t1);

    const t2 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ ...same, sweep: "sessions" }, t2);
    endSweepFailureCycle("sessions", t2);

    expect(getSweepFailures()).toHaveLength(1);
    expect(getSweepFailureTotal()).toBe(1);
  });

  it("counts a directory once even when one sweep trips over it twice", async () => {
    // The within-cycle half of the same rule.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const t = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/a", scope: "project-dir", sweep: "usage" }, t);
    recordSweepFailure({ path: "/a", scope: "project-dir", sweep: "usage" }, t);
    recordSweepFailure({ path: "/b", scope: "project-dir", sweep: "usage" }, t);
    endSweepFailureCycle("usage", t);

    // Two locations, three attempts.
    expect(getSweepFailureTotal()).toBe(2);
  });

  it("does not let a sweep invalidated mid-flight publish over its replacement", async () => {
    // A corpus-configuration change clears the collector while a sweep is
    // running. If a replacement sweep of the same name starts before the old
    // one finishes, the old caller's `end` used to decrement the NEW cycle's
    // depth to zero and publish its half-finished result as final — exposing
    // paths from the old configuration and dropping everything the replacement
    // found afterwards. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      clearSweepFailures: clear,
    } = await import("@/lib/sweepFailures");

    // The sweep that is about to be invalidated.
    const stale = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/removed-home", scope: "projects-dir", sweep: "usage" }, stale);

    // The user removes the unreachable home.
    clear();

    // A replacement sweep starts and is still running.
    const fresh = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/still-broken", scope: "projects-dir", sweep: "usage" }, fresh);

    // The OLD caller finishes. It must change nothing.
    endSweepFailureCycle("usage", stale);
    expect(getSweepFailures()).toHaveLength(0);

    // And the replacement still publishes its own, complete result.
    endSweepFailureCycle("usage", fresh);
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/still-broken"]);
  });
});

describe("round 6 — the invalidation guard reaches the writes too", () => {
  it("drops records from a sweep the config change invalidated", async () => {
    // Guarding only `end` was half a fix. The stale sweep goes on RUNNING and
    // goes on finding failures, and those landed in the replacement cycle's
    // pending result by sweep name — so paths from the old configuration were
    // published by the replacement, which is exactly what the generation check
    // was added to stop. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
      clearSweepFailures: clear,
    } = await import("@/lib/sweepFailures");

    const stale = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/before", scope: "projects-dir", sweep: "usage" }, stale);

    clear(); // the user removes the unreachable home

    const fresh = beginSweepFailureCycle("usage");
    // The invalidated sweep is still walking, and still finding things.
    recordSweepFailure({ path: "/removed-home", scope: "projects-dir", sweep: "usage" }, stale);
    recordSweepFailure({ path: "/still-broken", scope: "projects-dir", sweep: "usage" }, fresh);
    endSweepFailureCycle("usage", stale); // no-op
    endSweepFailureCycle("usage", fresh);

    // Only the replacement's finding, and the count agrees with the detail —
    // the stale record must not reach `total` either, which it would if it were
    // merely filtered at read time.
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/still-broken"]);
    expect(getSweepFailureTotal()).toBe(1);
  });

  /**
   * The next two are STRUCTURAL, and that is the point rather than a shortcut.
   *
   * Both defects are a MISSING CALL — a token not passed, a cycle not opened —
   * and both recurred after a behavioural fix that covered the instance and not
   * the class. I wrote the behavioural versions first and mutation-testing
   * showed neither discriminated: the scoped scan trips over the same
   * `projects` path as the full scan, so a fixture cannot make one fail while
   * the other succeeds without an unreadable PROJECT directory, which no
   * portable filesystem operation produces (Windows skips a non-directory
   * before the `readdir` that would report it). A rule over the source catches
   * every site including the ones a fixture cannot reach.
   */
  it("passes the cycle token at EVERY record site", async () => {
    // Three separate rounds of review found a `recordSweepFailure` without its
    // token — each time a different site, each time reintroducing the stale
    // write the guard exists to stop. The rule is what closes it: a new call
    // site added later fails this without anyone having to remember.
    // (Codex P2 + Copilot, PR #527.)
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/lib/usage/parser.ts",
      "src/lib/scanner/claudeConversations.ts",
    ];

    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(f, "utf-8");
      // Each call, from `recordSweepFailure(` to the `);` that closes it. The
      // arguments span several lines, so this walks braces rather than matching
      // a single line.
      let i = text.indexOf("recordSweepFailure(");
      while (i !== -1) {
        let depth = 0;
        let j = i + "recordSweepFailure".length;
        let end = -1;
        for (; j < text.length; j++) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") {
            depth--;
            if (depth === 0) {
              end = j;
              break;
            }
          }
        }
        const call = text.slice(i, end + 1);
        // A tokened call closes with `, <token>)` after the failure object.
        if (!/\}\s*,\s*[A-Za-z_.]+\s*\)$/.test(call)) {
          offenders.push(`${f}: ${call.slice(0, 60).replace(/\s+/g, " ")}…`);
        }
        i = text.indexOf("recordSweepFailure(", end);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("gives the project-scoped reader no failure cycle at all", async () => {
    // It enumerates a corpus the CALLER chose — `scanConversationDirs` skips
    // every directory outside `allowedDirs` — so it cannot answer "was the
    // corpus readable", which is the only question `/api/claude-homes` asks.
    // Two attempts to let it answer anyway both ended with one scan erasing
    // another's finding: first by sharing the `sessions` name, then by sharing
    // a `sessions-scoped` one across every distinct allow-set.
    // (Codex P2 x2, PR #527.)
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("src/lib/scanner/claudeConversations.ts", "utf-8");

    const start = text.indexOf("export async function scanClaudeConversationsForProjects");
    expect(start).toBeGreaterThan(-1);
    // Bounded by the next top-level declaration, not a fixed character count —
    // a fixed window stops covering the function as the file grows.
    //
    // `\n}` matches a brace at COLUMN 0, which in this file's formatting only
    // the function's own closing brace has; nested blocks are indented. A
    // review suggested this stops at the first `for` loop's close and a
    // brace-depth scan was needed — measured, and it does not: the slice runs
    // the full 33 lines to the `return`. Rather than replace a guard that
    // works, the assumption it rests on is asserted directly, so a reformat
    // that broke it would fail here instead of silently shrinking the window.
    const body = text.slice(start, text.indexOf("\n}", start));
    expect(body).toMatch(/return mergeClaudeUsageStats\(parts\);/);
    expect(body).not.toMatch(/beginSweepFailureCycle/);
  });
});

describe("round 8 — a fixed directory stops being reported", () => {
  it("retires another sweep's failure once a later sweep reads the path", async () => {
    // The `sessions` sweep runs during the first-reconcile / file fallback and
    // then normal DB-backed requests never call it again — so a directory it
    // found unreadable stayed named in the banner after the drive came back,
    // until a config change or a process restart. Meanwhile the `usage` sweep,
    // which walks the SAME tree, had been listing it cleanly all along.
    // (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    // The sweep that will never run again finds it broken.
    const t1 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: home, scope: "projects-dir", sweep: "sessions" }, t1);
    endSweepFailureCycle("sessions", t1);
    expect(getSweepFailures()).toHaveLength(1);

    // The user reconnects the drive. A later usage sweep reads it fine.
    const t2 = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", home, t2);
    endSweepFailureCycle("usage", t2);

    // The stale warning is gone, and the COUNT went with it — a total that
    // outlived the detail would leave the banner saying "1 location could not
    // be read" while naming none.
    expect(getSweepFailures()).toHaveLength(0);
    expect(getSweepFailureTotal()).toBe(0);
  });

  it("retires only the path that was verified", async () => {
    // Evidence, not a timer: reading one home says nothing about another.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const t1 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: "/home-a/projects", scope: "projects-dir", sweep: "sessions" }, t1);
    recordSweepFailure({ path: "/home-b/projects", scope: "projects-dir", sweep: "sessions" }, t1);
    endSweepFailureCycle("sessions", t1);

    const t2 = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", "/home-a/projects", t2);
    endSweepFailureCycle("usage", t2);

    expect(getSweepFailures().map((f) => f.path)).toEqual(["/home-b/projects"]);
  });

  it("does not retire a per-project failure on a home-level success", async () => {
    // Listing a home says nothing about whether one directory INSIDE it could
    // be read, so a `project-dir` entry must survive. Over-reporting is the safe
    // direction; silently dropping a real gap is the failure #513 exists to end.
    //
    // What actually makes this hold is the PATH, not the scope check beside it:
    // a verified path is always `<home>/projects` and a per-project failure is
    // always something below it, so the two can never be equal. Mutation-testing
    // showed exactly that — removing the scope condition changed nothing here.
    // The condition stays as a narrowing in case those path shapes ever
    // converge, and this test is honest that it pins the outcome rather than
    // that condition.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const t1 = beginSweepFailureCycle("sessions");
    recordSweepFailure(
      { path: "/home-a/projects/one-project", scope: "project-dir", sweep: "sessions" },
      t1
    );
    endSweepFailureCycle("sessions", t1);

    const t2 = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", "/home-a/projects", t2);
    endSweepFailureCycle("usage", t2);

    expect(getSweepFailures()).toHaveLength(1);
  });

  it("does not let an invalidated sweep retire anything", async () => {
    // `recordSweepSuccess` takes the same token as the failure path, or a sweep
    // superseded by a config change could clear the replacement's findings —
    // the same stale-write class, arriving from the other direction.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
      clearSweepFailures: clear,
    } = await import("@/lib/sweepFailures");

    const stale = beginSweepFailureCycle("usage");
    clear();

    const t = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: "/home-a/projects", scope: "projects-dir", sweep: "sessions" }, t);
    endSweepFailureCycle("sessions", t);

    // A REPLACEMENT usage cycle, and this is what makes the test discriminate.
    // Without it `pending()` holds no `usage` entry at all, so the stale
    // caller's success goes nowhere whether or not the token is checked — my
    // first version of this test passed against the unguarded code for exactly
    // that reason. With the replacement in flight, an unchecked success would
    // be adopted by it and retire the failure below on its own publish.
    const fresh = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", "/home-a/projects", stale);
    endSweepFailureCycle("usage", fresh);

    expect(getSweepFailures()).toHaveLength(1);
  });
});

describe("round 9 — three more ways the record was cleared or kept wrongly", () => {
  it("retires capped entries too, not just the ones it can still name", async () => {
    // `items` stops at the 50-entry detail cap while `seen` holds every key the
    // cycle recorded. Subtracting only the retained details left `total`
    // positive for the capped ones, so with more than 50 homes down and then
    // recovered, `/api/claude-homes` stayed degraded indefinitely while naming
    // nothing. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const homes = Array.from({ length: 60 }, (_, i) => `/home-${i}/projects`);

    const t1 = beginSweepFailureCycle("sessions");
    for (const h of homes) {
      recordSweepFailure({ path: h, scope: "projects-dir", sweep: "sessions" }, t1);
    }
    endSweepFailureCycle("sessions", t1);

    // The premise, and the reason this test exists: more failures than the
    // detail cap retains.
    expect(getSweepFailures().length).toBe(50);
    expect(getSweepFailureTotal()).toBe(60);

    // Every one of them comes back.
    const t2 = beginSweepFailureCycle("usage");
    for (const h of homes) recordSweepSuccess("usage", h, t2);
    endSweepFailureCycle("usage", t2);

    expect(getSweepFailures()).toHaveLength(0);
    // Zero, not 10. A banner reporting "10 locations could not be read" while
    // naming none is the state this fixes.
    expect(getSweepFailureTotal()).toBe(0);
  });

  it("keeps the previous result when the usage sweep aborts before enumerating", async () => {
    // `readConfig()` / `getReadableClaudeHomes()` rejecting is not evidence
    // about the filesystem. Opening the cycle before them meant the `finally`
    // published an empty result as this pass's answer, erasing a known failure
    // and reporting `complete: true` on the strength of a pass that never
    // touched a directory. (Codex P2, PR #527.)
    //
    // Source-level: provoking a `readConfig` rejection means mocking a module
    // the sweep imports dynamically, and the assertion that actually matters is
    // ORDER — that no cycle exists before those two awaits.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("src/lib/usage/parser.ts", "utf-8");

    const homesAt = text.indexOf("const homes = await getReadableClaudeHomes(config);");
    const cycleAt = text.indexOf('beginSweepFailureCycle("usage")');
    expect(homesAt).toBeGreaterThan(-1);
    expect(cycleAt).toBeGreaterThan(-1);
    expect(cycleAt).toBeGreaterThan(homesAt);
  });
});

describe("round 10 — an older success cannot retire a newer failure", () => {
  it("keeps a failure observed AFTER the success that would retire it", async () => {
    // The sweeps overlap, and a cycle publishes when it FINISHES rather than
    // when it looked. So `sessions` can list a directory, stay busy, and in
    // between `usage` can fail on that same path and publish — and the older
    // cycle's publish then dropped the newer failure, reporting
    // `complete: true` over an enumeration that had just failed.
    // (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    // The long-running sessions sweep reads it fine, and keeps going.
    const slow = beginSweepFailureCycle("sessions");
    recordSweepSuccess("sessions", home, slow);

    // Meanwhile the drive drops out. A usage sweep starts, fails, publishes.
    const quick = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: home, scope: "projects-dir", sweep: "usage" }, quick);
    endSweepFailureCycle("usage", quick);
    expect(getSweepFailures()).toHaveLength(1);

    // Only NOW does the older sweep finish. Its success is stale.
    endSweepFailureCycle("sessions", slow);

    expect(getSweepFailures().map((f) => f.path)).toEqual([home]);
  });

  it("still retires when the success genuinely came later", async () => {
    // The other half, and the reason this is an ordering fix rather than a ban:
    // a success that really does postdate the failure must still clear it, or
    // round 8's whole point is undone.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    const first = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: home, scope: "projects-dir", sweep: "sessions" }, first);
    endSweepFailureCycle("sessions", first);

    const later = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", home, later);
    endSweepFailureCycle("usage", later);

    expect(getSweepFailures()).toHaveLength(0);
  });
});

describe("round 11 — equivalent spellings are not a corpus change", () => {
  it("gives one tree one key however it is spelled", async () => {
    // The route decides whether to clear the failure record by comparing Claude
    // home path sets. Comparing the raw strings meant a trailing separator, or
    // the `wsl$` / `wsl.localhost` spelling of one UNC path, read as a
    // different corpus — erasing a live unreadable-directory diagnostic without
    // anything that gets swept having changed. (Codex P2, PR #527.)
    //
    // Asserted on the predicate itself rather than through the route: this is
    // where the equivalence lives, and `getClaudeHomes` already relies on it to
    // avoid parsing one history twice.
    const { homeDedupeKey } = await import("@/lib/claudeHome");

    // A trailing separator is the same tree.
    expect(homeDedupeKey("C:\\Users\\me\\.claude\\")).toBe(
      homeDedupeKey("C:\\Users\\me\\.claude")
    );

    // And WSL's two UNC hosts are aliases for one filesystem.
    expect(homeDedupeKey("\\\\wsl$\\Ubuntu\\home\\me\\.claude")).toBe(
      homeDedupeKey("\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude")
    );

    // The counterpart, or the check would pass by collapsing everything: two
    // genuinely different homes must keep different keys.
    expect(homeDedupeKey("C:\\Users\\me\\.claude")).not.toBe(
      homeDedupeKey("D:\\other\\.claude")
    );
    expect(homeDedupeKey("\\\\wsl$\\Ubuntu\\home\\me\\.claude")).not.toBe(
      homeDedupeKey("\\\\wsl$\\Debian\\home\\me\\.claude")
    );
  });
});

describe("round 12 — an entry redundant with the primary home is not a change", () => {
  it("treats the effective swept set as the thing that matters", async () => {
    // `config.claudeHomes` omits the implicit primary `~/.claude`, so adding an
    // entry equal to it changed that list while `getClaudeHomes` deduplicated
    // it straight back out — clearing a live unreadable-directory diagnostic
    // over a config edit that swept exactly the same directories.
    // (Codex P2, PR #527.)
    //
    // Asserted on `getClaudeHomes`, which is what the route now asks. The route
    // itself is a Next module this suite cannot execute; the structural guard
    // above pins that it asks.
    const { getClaudeHomes, homeDedupeKey, getPrimaryClaudeHome } = await import(
      "@/lib/claudeHome"
    );
    const base = { claudeHomes: [] } as unknown as Parameters<typeof getClaudeHomes>[0];
    const keys = (extra: string[]) =>
      new Set(getClaudeHomes({ ...base, claudeHomes: extra }).map(homeDedupeKey));

    // Naming the primary explicitly changes the config and not the corpus.
    expect(keys([getPrimaryClaudeHome()])).toEqual(keys([]));
    // ...including spelled with a trailing separator, which is the previous
    // round's equivalence arriving through this one.
    expect(keys([`${getPrimaryClaudeHome()}\\`])).toEqual(keys([]));

    // The counterpart: a genuinely new home IS a change, or the comparison
    // would never fire and the record would never clear.
    expect(keys(["D:\\elsewhere\\.claude"])).not.toEqual(keys([]));
  });
});

describe("round 13 — the capped arithmetic told the truth in neither direction", () => {
  it("deduplicates the entries past the DETAIL cap, not just the named ones", async () => {
    // `items` stops at 50 while `seen` tracks up to 2,000 keys. Deduplicating
    // only what was still named and adding each cycle's overflow blind meant 60
    // directories that BOTH sweeps tripped over reported 70 locations — each
    // cycle contributing 10 undeduplicated residuals. The keys were right there
    // the whole time. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailureTotal,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const dirs = Array.from({ length: 60 }, (_, i) => `/home/projects/p-${i}`);

    for (const sweep of ["usage", "sessions"] as const) {
      const t = beginSweepFailureCycle(sweep);
      for (const d of dirs) {
        recordSweepFailure({ path: d, scope: "project-dir", sweep }, t);
      }
      endSweepFailureCycle(sweep, t);
    }

    // The premise: both cycles overflowed the DETAIL cap, so the old formula's
    // blind residual is in play.
    expect(getSweepFailures().length).toBe(50);
    // 60 locations, not 70. Two sweeps walking one tree find one set of faults.
    expect(getSweepFailureTotal()).toBe(60);
  });

  it("still counts a location only one sweep found", async () => {
    // The counterpart: deduplicating by key must not merge distinct paths, or
    // the total would collapse toward whichever sweep saw fewest.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const t1 = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/shared", scope: "project-dir", sweep: "usage" }, t1);
    recordSweepFailure({ path: "/only-usage", scope: "project-dir", sweep: "usage" }, t1);
    endSweepFailureCycle("usage", t1);

    const t2 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: "/shared", scope: "project-dir", sweep: "sessions" }, t2);
    endSweepFailureCycle("sessions", t2);

    expect(getSweepFailureTotal()).toBe(2);
  });

  it("keeps the banner visible when only the count survives", async () => {
    // `retireVerified` can clear every retained DETAIL while failures past the
    // 50-entry cap remain counted. A `degraded.length` visibility gate then hid
    // the banner outright while the API went on reporting incomplete coverage —
    // the silence this whole feature exists to end, arriving through its own
    // cap. (Codex P2, PR #527.)
    //
    // Source-level: this suite has no DOM, so the component cannot be rendered.
    // The assertion is that neither the visibility gate nor the detail block
    // keys off the capped array.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("src/components/UnavailableHomesBanner.tsx", "utf-8");

    expect(text).toMatch(/homes\.length === 0 && degradedTotal === 0\)\) return null;/);
    expect(text).not.toMatch(/homes\.length === 0 && degraded\.length === 0/);
    // And the detail block is gated on the total as well, with count-only copy
    // for the case where nothing is left to name.
    expect(text).toMatch(/\{degradedTotal > 0 && \(/);
    expect(text).toMatch(/degraded\.length === 0 \? \(/);
  });
});

describe("an ENOENT message names both of its causes", () => {
  it("does not pick one and send the reader down the wrong path", async () => {
    // A RECORDED ENOENT is never "a fresh install with no projects/ yet" —
    // that case is deliberately silent. It is either the HOME being gone or the
    // `projects` entry being unresolvable. The original wording named only the
    // first; my first attempt at fixing it named only the second. Both are
    // equally misleading, which is why this asserts the presence of BOTH.
    // (Copilot, PR #527.)
    const { describeSweepFailure } = await import("@/lib/sweepFailures");
    const msg = describeSweepFailure({
      path: "/x/projects",
      scope: "projects-dir",
      code: "ENOENT",
      sweep: "usage",
    });

    expect(msg).toContain("home may be gone");
    expect(msg).toContain("not connected");
    expect(msg).not.toContain("no longer exists");
  });
});

describe("a dangling subagents link is not an absent one", () => {
  it.skipIf(!symlinkAvailable)("reports it instead of suppressing it", async () => {
    // The home-level ENOENT already asked `pathEntryExists`; the NESTED
    // `subagents/` check did not, so a `subagents` entry pointing at a
    // disconnected drive was suppressed as "no subagents directory here" and
    // the sweep published a complete result over transcripts it never read.
    // (Codex P2, PR #527.)
    const projectDir = path.join(tmpHome, ".claude", "projects", "-home-me-dev-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "s1.jsonl"), "{}\n");
    // Under a SESSION directory, which is where the reader looks:
    // `<project>/<session-id>/subagents`. My first fixture put it directly
    // under the project dir, so the loop never reached it and the test failed
    // on its own arrangement rather than on the code.
    const sessionDir = path.join(projectDir, "cafe1234");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.symlink(
      path.join(tmpHome, "disconnected-drive", "subagents"),
      path.join(sessionDir, "subagents"),
      "dir"
    );

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});

    const failures = getSweepFailures().filter((f) => f.path.includes("subagents"));
    expect(failures.length).toBeGreaterThan(0);
  });

  it("still says nothing about a project with no subagents directory", async () => {
    // The common case by far, and the reason the fix is `lstat` rather than
    // "report every nested ENOENT": most projects have never spawned an agent,
    // and warning on each would bury the real faults.
    const projectDir = path.join(tmpHome, ".claude", "projects", "-home-me-dev-app");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "s1.jsonl"), "{}\n");

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    expect(getSweepFailures()).toHaveLength(0);
  });
});

describe("a config change forgets only the homes that left", () => {
  it("keeps a still-configured home's live failure", async () => {
    // With two homes configured and one still unreadable, adding or removing an
    // unrelated third wiped the surviving home's failure too — and the endpoint
    // then reported `complete: true` until a full file sweep happened to run
    // again, which on the normal DB-backed path may be never.
    // (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
      forgetSweepFailuresUnder,
    } = await import("@/lib/sweepFailures");

    const staying = path.join(tmpHome, "home-a", ".claude");
    const leaving = path.join(tmpHome, "home-b", ".claude");

    const t = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: path.join(staying, "projects"), scope: "projects-dir", sweep: "usage" },
      t
    );
    recordSweepFailure(
      { path: path.join(leaving, "projects"), scope: "projects-dir", sweep: "usage" },
      t
    );
    // A per-project failure BENEATH the departing home goes with it.
    recordSweepFailure(
      { path: path.join(leaving, "projects", "-p"), scope: "project-dir", sweep: "usage" },
      t
    );
    endSweepFailureCycle("usage", t);
    expect(getSweepFailureTotal()).toBe(3);

    forgetSweepFailuresUnder([leaving]);

    // The departing home and everything under it are gone; the home that is
    // still configured and still unreadable is still reported.
    expect(getSweepFailures().map((f) => f.path)).toEqual([
      path.join(staying, "projects"),
    ]);
    // And the count came down with the detail, rather than leaving the banner
    // claiming three locations while naming one.
    expect(getSweepFailureTotal()).toBe(1);
  });

  it("still invalidates an in-flight sweep even when nothing was removed", async () => {
    // Adding a home removes nothing, but a sweep already running was
    // enumerating the OLD set and must not publish into the new one — so the
    // generation bump happens regardless of whether there is anything to prune.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      forgetSweepFailuresUnder,
    } = await import("@/lib/sweepFailures");

    const stale = beginSweepFailureCycle("usage");
    forgetSweepFailuresUnder([]);

    recordSweepFailure({ path: "/x/projects", scope: "projects-dir", sweep: "usage" }, stale);
    endSweepFailureCycle("usage", stale);

    expect(getSweepFailures()).toHaveLength(0);
  });
});

describe("round 21 — one canonical path space, and a cycle that reads its own successes", () => {
  it("treats two spellings of one path as one location", async () => {
    // Keys were raw strings, so the two WSL host aliases counted as two
    // locations and a success under one could not retire a failure under the
    // other. The config layer has always treated them as one tree — the keys
    // had to as well. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const legacy = "\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects";
    const modern = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects";

    const t1 = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: legacy, scope: "projects-dir", sweep: "usage" }, t1);
    endSweepFailureCycle("usage", t1);

    const t2 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: modern, scope: "projects-dir", sweep: "sessions" }, t2);
    endSweepFailureCycle("sessions", t2);

    // One directory, one location — not two.
    expect(getSweepFailureTotal()).toBe(1);
  });

  it("lets a success under one spelling retire a failure under the other", async () => {
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const legacy = "\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects";
    const modern = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects";

    const t1 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: legacy, scope: "projects-dir", sweep: "sessions" }, t1);
    endSweepFailureCycle("sessions", t1);
    expect(getSweepFailures()).toHaveLength(1);

    const t2 = beginSweepFailureCycle("usage");
    recordSweepSuccess("usage", modern, t2);
    endSweepFailureCycle("usage", t2);

    expect(getSweepFailures()).toHaveLength(0);
  });

  it("retires a failure its OWN cycle later read successfully", async () => {
    // Two `scanAllSessions()` calls can overlap and share one pending result,
    // so within a single cycle a path can fail and then be listed fine. The
    // published result kept the failure, because `retireVerified` skips the
    // publishing sweep — so the banner named a directory the newest
    // observation had read. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    // Outer caller opens the cycle and trips over the path.
    const outer = beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: home, scope: "projects-dir", sweep: "sessions" }, outer);

    // An overlapping caller joins the SAME cycle and reads it fine.
    const inner = beginSweepFailureCycle("sessions");
    recordSweepSuccess("sessions", home, inner);
    endSweepFailureCycle("sessions", inner); // inner does not publish

    endSweepFailureCycle("sessions", outer);

    expect(getSweepFailures()).toHaveLength(0);
    // The count comes down too, or the banner reports a location it cannot name.
    expect(getSweepFailureTotal()).toBe(0);
  });

  it("does not retire a failure its own cycle saw AFTER the success", async () => {
    // The counterpart. Order decides it here exactly as it does across sweeps,
    // or a stale success would hide a fresh fault.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    const t = beginSweepFailureCycle("sessions");
    recordSweepSuccess("sessions", home, t);
    recordSweepFailure({ path: home, scope: "projects-dir", sweep: "sessions" }, t);
    endSweepFailureCycle("sessions", t);

    expect(getSweepFailures().map((f) => f.path)).toEqual([home]);
  });
});

describe("pruning a removed home uses the canonical path space too", () => {
  const onWindows = path.sep === "\\";

  it.skipIf(!onWindows)("prunes a home saved with the other separator", async () => {
    // Config entries are hand-editable and `.minder.json` round-trips whatever
    // was typed, so a home saved as `C:/x/.claude` must still prune failures
    // recorded against `C:\x\.claude\projects`. A `path.sep`-based prefix
    // missed it and left a stale warning after the home was removed.
    // (Copilot, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      forgetSweepFailuresUnder,
    } = await import("@/lib/sweepFailures");

    const nativeHome = "C:\\devhomes\\alpha\\.claude";
    const forwardSlashSpelling = "C:/devhomes/alpha/.claude";

    const t = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: `${nativeHome}\\projects`, scope: "projects-dir", sweep: "usage" },
      t
    );
    endSweepFailureCycle("usage", t);
    expect(getSweepFailures()).toHaveLength(1);

    forgetSweepFailuresUnder([forwardSlashSpelling]);
    expect(getSweepFailures()).toHaveLength(0);
  });

  it.skipIf(onWindows)("keeps a POSIX home that differs only in case", async () => {
    // `/data/Claude` and `/data/claude` are DIFFERENT directories on POSIX, and
    // `normalizePathKey` preserves that deliberately. Folding case
    // unconditionally deleted a still-valid failure under the second when the
    // first was removed. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      forgetSweepFailuresUnder,
    } = await import("@/lib/sweepFailures");

    const t = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: "/data/claude/projects", scope: "projects-dir", sweep: "usage" },
      t
    );
    endSweepFailureCycle("usage", t);

    forgetSweepFailuresUnder(["/data/Claude"]);

    expect(getSweepFailures().map((f) => f.path)).toEqual(["/data/claude/projects"]);
  });

  it("does not prune a sibling whose name merely shares a prefix", async () => {
    // Removing `.../claude` must not take `.../claude-backup` with it — the
    // reason the match is separator-aware rather than a bare `startsWith`.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      forgetSweepFailuresUnder,
    } = await import("@/lib/sweepFailures");

    const sibling = path.join(tmpHome, "claude-backup");
    const t = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: path.join(sibling, "projects"), scope: "projects-dir", sweep: "usage" },
      t
    );
    endSweepFailureCycle("usage", t);

    forgetSweepFailuresUnder([path.join(tmpHome, "claude")]);

    expect(getSweepFailures()).toHaveLength(1);
  });
});

describe("a repeated failure is deduplicated but re-stamped", () => {
  it("survives an INTERMEDIATE success in the same cycle", async () => {
    // Three overlapping callers can share one cycle and observe a directory as
    // failure -> success -> failure. Keeping the FIRST failure's timestamp made
    // the intermediate success look newer than the last observation, so
    // `prunePublished` retired a failure that was still true and the endpoint
    // reported complete. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";
    const failure = { path: home, scope: "projects-dir" as const, sweep: "sessions" as const };

    const t = beginSweepFailureCycle("sessions");
    recordSweepFailure(failure, t);
    recordSweepSuccess("sessions", home, t);
    recordSweepFailure(failure, t); // the newest observation, and it failed
    endSweepFailureCycle("sessions", t);

    expect(getSweepFailures().map((f) => f.path)).toEqual([home]);
    // Still ONE location — re-stamping must not re-count it.
    expect(getSweepFailureTotal()).toBe(1);
  });

  it("still retires when the success really is the last word", async () => {
    // The counterpart: re-stamping must not make failures unretirable, or
    // round 8's whole point is undone.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      recordSweepSuccess,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";
    const failure = { path: home, scope: "projects-dir" as const, sweep: "sessions" as const };

    const t = beginSweepFailureCycle("sessions");
    recordSweepFailure(failure, t);
    recordSweepFailure(failure, t);
    recordSweepSuccess("sessions", home, t);
    endSweepFailureCycle("sessions", t);

    expect(getSweepFailures()).toHaveLength(0);
  });
});

describe("the banner treats an empty list as recovery, a missing key as silence", () => {
  it("clears unavailable homes when the server reports none", async () => {
    // `if (data?.unavailable)` treated `[]` as "no news", so the warning stuck
    // after the home came back. `degraded` already had this right; `unavailable`
    // did not. (Copilot, PR #527.)
    //
    // Source-level: no DOM in this suite. The distinction being asserted is
    // `Array.isArray` over truthiness — an empty array is a real answer, a
    // missing key is an older server and must leave the last one alone.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("src/components/UnavailableHomesBanner.tsx", "utf-8");

    expect(text).toMatch(/if \(data && Array\.isArray\(data\.unavailable\)\) setHomes\(data\.unavailable\);/);
    expect(text).not.toMatch(/if \(data\?\.unavailable\) setHomes/);
  });
});

describe("deduplication keeps the newest observation of a location", () => {
  it("does not let an older errno mask a newer one", async () => {
    // Insertion order kept whichever sweep's result was iterated first, so an
    // older `EACCES` masked a later `ENOTDIR` for the same path — and the
    // banner went on advising about permissions after the cause had changed.
    // The errno is the actionable half: those two send someone to do
    // completely different things. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    const older = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "EACCES", sweep: "usage" },
      older
    );
    endSweepFailureCycle("usage", older);

    const newer = beginSweepFailureCycle("sessions");
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "ENOTDIR", sweep: "sessions" },
      newer
    );
    endSweepFailureCycle("sessions", newer);

    const failures = getSweepFailures();
    // Still one location...
    expect(failures).toHaveLength(1);
    expect(getSweepFailureTotal()).toBe(1);
    // ...described by the NEWEST observation of it.
    expect(failures[0].code).toBe("ENOTDIR");
  });

  it("keeps the newer one whichever sweep saw it first", async () => {
    // The counterpart, so the test cannot be passing on iteration order: the
    // same assertion with the sweeps swapped.
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    const older = beginSweepFailureCycle("sessions");
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "EACCES", sweep: "sessions" },
      older
    );
    endSweepFailureCycle("sessions", older);

    const newer = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "ENOTDIR", sweep: "usage" },
      newer
    );
    endSweepFailureCycle("usage", newer);

    expect(getSweepFailures()[0].code).toBe("ENOTDIR");
  });
});

describe("the banner distinguishes an empty list from a missing key", () => {
  it("applies the same rule to degraded as to unavailable", async () => {
    // The previous revision fixed `unavailable` and left `degraded` on
    // `?? []` — which clears the list when the key is MISSING, the exact
    // behaviour the comment beside it argues against. An older server, or a
    // rolling deploy, would have wiped a live warning. (Copilot, PR #527.)
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("src/components/UnavailableHomesBanner.tsx", "utf-8");

    expect(text).toMatch(/if \(data && Array\.isArray\(data\.degraded\)\) setDegraded\(data\.degraded\);/);
    expect(text).not.toMatch(/setDegraded\(data\.degraded \?\? \[\]\)/);
    // And the total follows the same rule rather than reading through a
    // missing key.
    expect(text).toMatch(/typeof data\.degradedTotal === "number"/);
  });
});

describe("the merged detail list honours the documented cap", () => {
  it("does not hand back 50 per sweep", async () => {
    // `MAX_PER_SWEEP` bounds what each CYCLE retains, so two sweeps could
    // return 100 distinct locations between them — while the API contract, the
    // banner and this module's own docs all say the detail is bounded at 50
    // with `degradedTotal` carrying the uncapped count. A cap that does not
    // apply where the lists merge is not a cap on what a caller receives.
    // (Copilot, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    // Disjoint paths per sweep, so nothing deduplicates and each cycle fills
    // its own 50-entry detail list.
    for (const sweep of ["usage", "sessions"] as const) {
      const t = beginSweepFailureCycle(sweep);
      for (let i = 0; i < 60; i++) {
        recordSweepFailure(
          { path: `/${sweep}/p-${i}`, scope: "project-dir", sweep },
          t
        );
      }
      endSweepFailureCycle(sweep, t);
    }

    expect(getSweepFailures()).toHaveLength(50);
    // And the COUNT is unaffected by the detail cap — 120 distinct locations,
    // which is the whole reason the two figures are separate.
    expect(getSweepFailureTotal()).toBe(120);
  });
});

describe("a re-observed failure carries its newest detail", () => {
  it("replaces the errno within one cycle, not just the timestamp", async () => {
    // `getSweepFailures` was taught to prefer the newest detail ACROSS sweeps;
    // the same defect survived WITHIN a cycle, where re-stamping a duplicate
    // left the original object in place. A later `ENOTDIR` displayed as the
    // earlier `EACCES` sends the user to fix permissions on a path that is
    // actually a file. (Codex P2, PR #527.)
    const {
      beginSweepFailureCycle,
      endSweepFailureCycle,
      recordSweepFailure,
      getSweepFailures,
      getSweepFailureTotal,
    } = await import("@/lib/sweepFailures");

    const home = "/home/me/.claude/projects";

    const t = beginSweepFailureCycle("usage");
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "EACCES", sweep: "usage" },
      t
    );
    recordSweepFailure(
      { path: home, scope: "projects-dir", code: "ENOTDIR", sweep: "usage" },
      t
    );
    endSweepFailureCycle("usage", t);

    const failures = getSweepFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe("ENOTDIR");
    // Still one location — replacing must not re-count it.
    expect(getSweepFailureTotal()).toBe(1);
  });
});

describe("a dangling implicit home is not a fresh install", () => {
  it.skipIf(!symlinkAvailable)("reports it rather than exempting it", async () => {
    // The absent-primary exemption added last round was too broad: if
    // `~/.claude` is ITSELF a symlink to a disconnected drive,
    // `directoryExists(home)` is false (it follows the broken link) and so is
    // `pathEntryExists(projectsDir)` — so the exemption fired and the sweep
    // published a clean result while ALL Claude history was unavailable.
    // (Codex P2, PR #527.)
    //
    // `tmpHome` is the mocked `os.homedir()`, so `<tmpHome>/.claude` IS the
    // implicit primary — the exemption applies here and must not.
    await fs.symlink(
      path.join(tmpHome, "disconnected-drive", ".claude"),
      path.join(tmpHome, ".claude"),
      "dir"
    );

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});

    const failures = getSweepFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].scope).toBe("projects-dir");
  });

  it("still exempts a primary that was never created", async () => {
    // The counterpart, and the reason this is an `lstat` rather than dropping
    // the exemption: on a fresh machine — or one that only ever ran Codex or
    // Gemini — `~/.claude` does not exist at all, and warning there would put a
    // permanent banner on a machine with nothing wrong with it.
    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    expect(getSweepFailures()).toHaveLength(0);
  });
});
