import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import {
  beginSweepFailureCycle,
  endSweepFailureCycle,
  recordSweepFailure,
  getSweepFailures,
  clearSweepFailures,
  describeSweepFailure,
} from "@/lib/sweepFailures";

/**
 * #513 — the readers report the enumerations they could not complete, instead
 * of catching them and carrying on silently.
 *
 * #479 could only report the never-wake exclusion: a home Minder DECIDES not to
 * touch. Every other way the corpus shrinks — a disconnected drive, a moved
 * home, changed permissions, a `projects` path that is a file, one project
 * directory with a restrictive ACL — showed up as a swallowed `readdir` error
 * while `complete: true` was still reported.
 *
 * PR #510 tried an independent readability probe and spent five review rounds
 * establishing that "is this home readable" has no single depth. This is the
 * other shape the issue prescribes: hand back what the readers ALREADY know,
 * which cannot disagree with the corpus because it *is* the corpus.
 */

describe("the collector", () => {
  beforeEach(() => clearSweepFailures());
  afterEach(() => clearSweepFailures());

  it("keeps only the most recent COMPLETED cycle per sweep", () => {
    // A home that failed an hour ago and has since recovered must not still be
    // reported — but the replacement happens when the new cycle FINISHES.
    beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/a", scope: "projects-dir", sweep: "usage" });
    endSweepFailureCycle("usage");
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/a"]);

    beginSweepFailureCycle("usage");
    endSweepFailureCycle("usage");
    expect(getSweepFailures()).toHaveLength(0);
  });

  it("keeps the previous result visible while the next sweep runs", () => {
    // A sweep can take a while. Clearing at the START meant a poll landing
    // mid-way saw an empty list — reporting `complete: true` and dropping the
    // banner for a fault that was still there, then bringing it back when the
    // sweep finished (Codex P2, PR #527).
    beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/still-broken", scope: "projects-dir", sweep: "usage" });
    endSweepFailureCycle("usage");

    beginSweepFailureCycle("usage");
    // Mid-sweep: the last known answer, not an empty one.
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/still-broken"]);

    recordSweepFailure({ path: "/still-broken", scope: "projects-dir", sweep: "usage" });
    endSweepFailureCycle("usage");
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/still-broken"]);
  });

  it("publishes what a cycle found even if it is ended early", () => {
    // The sweeps end their cycle in a `finally`, so a pass that threw still
    // reports what it observed — and those partial findings are usually the
    // relevant ones, since a failure severe enough to stop the sweep is exactly
    // what a reader needs to see.
    beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/died-here", scope: "project-dir", sweep: "usage" });
    endSweepFailureCycle("usage");
    expect(getSweepFailures().map((f) => f.path)).toEqual(["/died-here"]);
  });

  it("does not let one sweep clear another's", () => {
    // Two readers walk the same tree on different schedules. The usage sweep
    // starting must not erase what the sessions scan just found, or a fast
    // poller would keep wiping a slow one's report.
    beginSweepFailureCycle("sessions");
    recordSweepFailure({ path: "/s", scope: "projects-dir", sweep: "sessions" });
    endSweepFailureCycle("sessions");
    beginSweepFailureCycle("usage");
    recordSweepFailure({ path: "/u", scope: "project-dir", sweep: "usage" });
    endSweepFailureCycle("usage");

    expect(getSweepFailures().map((f) => f.path).sort()).toEqual(["/s", "/u"]);
  });

  it("ignores a record with no cycle started", () => {
    // A sweep that records without opening a cycle is a wiring bug. Silently
    // starting one here would hide it AND let entries accumulate across passes
    // for the life of the process.
    recordSweepFailure({ path: "/orphan", scope: "projects-dir", sweep: "usage" });
    endSweepFailureCycle("usage");
    expect(getSweepFailures()).toHaveLength(0);
  });

  it("bounds what one sweep can record", () => {
    // A tree with thousands of unreadable directories would otherwise turn a
    // diagnostic into a memory leak, and no banner renders a thousand rows.
    beginSweepFailureCycle("usage");
    for (let i = 0; i < 200; i++) {
      recordSweepFailure({ path: `/p${i}`, scope: "project-dir", sweep: "usage" });
    }
    endSweepFailureCycle("usage");
    expect(getSweepFailures().length).toBeLessThanOrEqual(50);
  });
});

describe("describeSweepFailure", () => {
  it("says what to do, not what the errno was", () => {
    // "EACCES" tells a reader nothing they can act on.
    expect(
      describeSweepFailure({ path: "/x", scope: "projects-dir", code: "EACCES", sweep: "usage" })
    ).toContain("permission denied");
    expect(
      describeSweepFailure({ path: "/x", scope: "project-dir", code: "ENOTDIR", sweep: "usage" })
    ).toContain("not a directory");
  });

  it("distinguishes a missing HOME from a missing project directory", () => {
    // Different problems with different fixes, and the banner has to be able to
    // tell them apart — that granularity is what the issue asks for.
    const home = describeSweepFailure({
      path: "/x",
      scope: "projects-dir",
      code: "ENOENT",
      sweep: "usage",
    });
    const project = describeSweepFailure({
      path: "/x",
      scope: "project-dir",
      code: "ENOENT",
      sweep: "usage",
    });
    expect(home).not.toBe(project);
    expect(home).toContain("Claude home");
    expect(project).toContain("project directory");
  });

  it("still says something useful for an errno it does not know", () => {
    const out = describeSweepFailure({
      path: "/x",
      scope: "projects-dir",
      code: "EMFILE",
      sweep: "usage",
    });
    expect(out).toContain("EMFILE");
    expect(out).toContain("could not be listed");
  });
});

describe("the usage sweep reports its own failures", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-sweepfail-"));
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

  it("reports a `projects` path that is a FILE rather than a directory", async () => {
    // One of the cases the issue names, and one an existence check would pass:
    // the path is there, it just cannot be listed.
    await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".claude", "projects"), "not a directory");

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures: read } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});

    const failures = read();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].scope).toBe("projects-dir");
    expect(failures[0].sweep).toBe("usage");
  });

  it("does NOT report a fresh install with no projects directory yet", async () => {
    // `~/.claude` exists, `projects/` does not — which is every install before
    // its first session. Reporting that as degraded would put a permanent
    // warning on a machine with nothing wrong with it (Codex P2 + Copilot,
    // PR #527).
    await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures: read } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    expect(read()).toHaveLength(0);
  });

  it("DOES report a home that is gone entirely", async () => {
    // The other side of the same ENOENT. Nothing is created under `tmpHome`, so
    // the home itself is missing — a moved or unmounted home, which is a real
    // gap rather than an empty one.
    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures: read } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    const failures = read();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].scope).toBe("projects-dir");
  });

  it("reports nothing when the tree reads cleanly", async () => {
    // The other half, and the one that keeps this from being noise: a normal
    // home must produce an empty list, or the banner is permanent.
    const dir = path.join(tmpHome, ".claude", "projects", "-home-me-dev-app");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1.jsonl"), "{}\n");

    const { streamAllSessions } = await import("@/lib/usage/parser");
    const { getSweepFailures: read } = await import("@/lib/sweepFailures");

    await streamAllSessions(async () => {});
    expect(read()).toHaveLength(0);
  });
});
