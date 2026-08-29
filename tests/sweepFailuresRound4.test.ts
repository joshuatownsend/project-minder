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

    // And it still happens where it belongs. `corpusShapeChanged` is set by
    // exactly the three settings that move the swept set: `claudeHomes`,
    // `pathMappings`, `enabledAdapters`.
    const guardStart = route.indexOf("if (corpusShapeChanged) {");
    expect(guardStart).toBeGreaterThan(-1);
    const guard = route.slice(guardStart, route.indexOf("\n  }", guardStart));
    expect(guard).toMatch(/clearSweepFailures\(\)/);
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
    recordSweepFailure({ ...same, sweep: "usage" });
    endSweepFailureCycle("usage", t1);

    const t2 = beginSweepFailureCycle("sessions");
    recordSweepFailure({ ...same, sweep: "sessions" });
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
    recordSweepFailure({ path: "/a", scope: "project-dir", sweep: "usage" });
    recordSweepFailure({ path: "/a", scope: "project-dir", sweep: "usage" });
    recordSweepFailure({ path: "/b", scope: "project-dir", sweep: "usage" });
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
    recordSweepFailure({ path: "/removed-home", scope: "projects-dir", sweep: "usage" });

    // The user removes the unreachable home.
    clear();

    // A replacement sweep starts and is still running.
    const fresh = beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/still-broken", scope: "projects-dir", sweep: "usage" });

    // The OLD caller finishes. It must change nothing.
    endSweepFailureCycle("usage", stale);
    expect(getSweepFailures()).toHaveLength(0);

    // And the replacement still publishes its own, complete result.
    endSweepFailureCycle("usage", fresh);
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/still-broken"]);
  });
});
