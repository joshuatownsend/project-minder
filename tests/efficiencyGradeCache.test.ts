import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies before importing the cache
vi.mock("@/lib/usage/parser", () => ({
  parseAllSessions: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn().mockResolvedValue({ agents: [], skills: [], commands: [] }),
}));
vi.mock("@/lib/scanner/wasteOptimizer", () => ({
  runWasteOptimizer: vi.fn().mockReturnValue({ grade: "B", findings: [], counts: {} }),
}));
vi.mock("@/lib/usage/projectMatch", () => ({
  gatherProjectTurns: vi.fn().mockReturnValue([]),
  buildProjectTurnsIndex: vi.fn().mockReturnValue({ bySlug: new Map(), byDirName: new Map() }),
  lookupProjectTurns: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn().mockResolvedValue({}),
}));
// The drain's one remaining I/O call. Unmocked, it reaches the real SQLite
// index at ~/.minder/index.db via getDb/ensureSchemaReady — and better-sqlite3
// is synchronous, so it blocks the event loop rather than yielding. Sibling
// tests each leave a background drain running past their own end, so those
// blocking calls stack up and starve this file's timers: the async test below
// blew the 30s testTimeout instead of failing its own 2s vi.waitFor. Mocking
// it also stops the suite writing grade-snapshot rows into the developer's
// real index DB.
vi.mock("@/lib/data/gradeSnapshots", () => ({
  recordGradeSnapshots: vi.fn().mockResolvedValue(undefined),
}));

// The drain waits for the initial reconcile before its whole-corpus parse
// (#585). Default: settled at once, so every test below behaves as before; the
// gating tests swap in a deferred one-shot.
vi.mock("@/lib/db/ingestSettled", () => ({
  readInitialReconcilePending: vi.fn().mockResolvedValue(false),
  waitUntilSettled: vi.fn().mockResolvedValue("settled"),
}));

import { efficiencyGradeCache, type EfficiencyGrade } from "@/lib/efficiencyGradeCache";
import { parseAllSessions } from "@/lib/usage/parser";
import { waitUntilSettled } from "@/lib/db/ingestSettled";

// Flush globalThis singleton between tests by disposing
beforeEach(() => {
  efficiencyGradeCache.dispose();
});

describe("efficiencyGradeCache", () => {
  it("starts empty", () => {
    expect(efficiencyGradeCache.get("any")).toBeNull();
    expect(efficiencyGradeCache.total).toBe(0);
    expect(efficiencyGradeCache.pending).toBe(0);
  });

  it("skips projects with no sessions", () => {
    efficiencyGradeCache.enqueue([
      { slug: "no-sessions", path: "/p", hasSessions: false },
    ]);
    expect(efficiencyGradeCache.pending).toBe(0);
  });

  it("enqueues projects with sessions", () => {
    efficiencyGradeCache.enqueue([
      { slug: "has-sessions", path: "/p", hasSessions: true },
    ]);
    // One item in queue (not yet processed — async)
    expect(efficiencyGradeCache.pending).toBe(1);
  });

  it("deduplicates on repeated enqueue before processing", () => {
    efficiencyGradeCache.enqueue([
      { slug: "dup", path: "/p", hasSessions: true },
      { slug: "dup", path: "/p", hasSessions: true },
    ]);
    expect(efficiencyGradeCache.pending).toBe(1);
  });

  it("getAll returns empty when no grades have been computed", () => {
    expect(efficiencyGradeCache.getAll()).toEqual({});
  });

  it("dispose resets all state", () => {
    efficiencyGradeCache.enqueue([{ slug: "p1", path: "/p1", hasSessions: true }]);
    expect(efficiencyGradeCache.pending).toBe(1);
    efficiencyGradeCache.dispose();
    expect(efficiencyGradeCache.pending).toBe(0);
    expect(efficiencyGradeCache.total).toBe(0);
  });

  it("grades are valid enum values after processing", async () => {
    const validGrades: EfficiencyGrade[] = ["A", "B", "C", "D", "F"];
    efficiencyGradeCache.enqueue([{ slug: "p2", path: "/p2", hasSessions: true }]);
    // Wait until the background worker drains (pending reaches 0).
    await vi.waitFor(() => {
      expect(efficiencyGradeCache.pending).toBe(0);
    }, { timeout: 2000 });
    const grade = efficiencyGradeCache.get("p2");
    expect(grade).not.toBeNull();
    expect(validGrades).toContain(grade);
  });
});

describe("efficiencyGradeCache — deferred behind the initial reconcile (#585)", () => {
  /** Make the next drain's settle-wait hang until the returned `release()`. */
  function holdNextWait(): { release: () => void } {
    const held: { release: () => void } = { release: () => {} };
    vi.mocked(waitUntilSettled).mockImplementationOnce(
      () => new Promise((resolve) => { held.release = () => resolve("settled"); })
    );
    return held;
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("does not start the whole-corpus parse until the reconcile has settled", async () => {
    vi.mocked(parseAllSessions).mockClear();
    const held = holdNextWait();

    efficiencyGradeCache.enqueue([{ slug: "gated", path: "/p", hasSessions: true }]);
    await tick();

    expect(parseAllSessions).not.toHaveBeenCalled();
    // Still counted, so the dashboard shows grades as pending rather than absent.
    expect(efficiencyGradeCache.pending).toBe(1);

    held.release();
    await vi.waitFor(() => expect(efficiencyGradeCache.pending).toBe(0), { timeout: 2000 });
    expect(parseAllSessions).toHaveBeenCalledTimes(1);
    expect(efficiencyGradeCache.get("gated")).not.toBeNull();
  });

  it("folds enqueues that arrive during the wait into the same single sweep", async () => {
    vi.mocked(parseAllSessions).mockClear();
    const held = holdNextWait();

    efficiencyGradeCache.enqueue([{ slug: "first", path: "/a", hasSessions: true }]);
    await tick();
    efficiencyGradeCache.enqueue([{ slug: "second", path: "/b", hasSessions: true }]);
    await tick();
    expect(parseAllSessions).not.toHaveBeenCalled();

    held.release();
    await vi.waitFor(() => expect(efficiencyGradeCache.pending).toBe(0), { timeout: 2000 });
    // One parse for both projects — a second drain starting mid-wait would have
    // doubled the sweep this change exists to avoid.
    expect(parseAllSessions).toHaveBeenCalledTimes(1);
    expect(efficiencyGradeCache.get("first")).not.toBeNull();
    expect(efficiencyGradeCache.get("second")).not.toBeNull();
  });

  it("drops the deferred work when the cache is disposed during the wait", async () => {
    vi.mocked(parseAllSessions).mockClear();
    const held = holdNextWait();

    efficiencyGradeCache.enqueue([{ slug: "stale", path: "/p", hasSessions: true }]);
    await tick();
    efficiencyGradeCache.dispose();

    held.release();
    await tick();
    // The config that queued this work is gone; parsing for it now would land
    // grades computed from the old config in the freshly cleared cache.
    expect(parseAllSessions).not.toHaveBeenCalled();
    expect(efficiencyGradeCache.get("stale")).toBeNull();
  });
});
