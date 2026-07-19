import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import type { UsageComparison } from "@/lib/usage/types";

/** Narrow a UsageComparison to its comparable variant (throws otherwise) so
 *  tests can read current/previous/deltas/windows without `!`. */
function assertComparable(
  cmp: UsageComparison
): asserts cmp is Extract<UsageComparison, { comparable: true }> {
  if (!cmp.comparable) throw new Error(`expected comparable, got reason: ${cmp.reason}`);
}

// Item 4a — period-over-period comparison. Drives a windowed fixture through
// the real DB backend (reconcile → SQL aggregate) and asserts window math,
// delta math, division-by-zero handling, the "all" not-comparable case, and
// project-filter threading. `now` is injected into `compareUsageFromSql` so
// the windows are deterministic; the façade's not-comparable branches
// (MINDER_USE_DB=0, "all") are checked separately since they don't depend on
// a pinned clock.
//
// Skipped when better-sqlite3 isn't loadable — the DB backend can't run.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalUseDb: string | undefined;

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
  isSidechain?: boolean;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(timestamp: string, text: string): JsonlEntry {
  return { type: "user", timestamp, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(
  timestamp: string,
  text: string,
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = [],
  inputTokens = 100,
  outputTokens = 50
): JsonlEntry {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-sonnet-4-5",
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

// Pinned clock. With period "7d":
//   current  = [2026-04-23T12:00Z, 2026-04-30T12:00Z)
//   previous = [2026-04-16T12:00Z, 2026-04-23T12:00Z)
const NOW = new Date("2026-04-30T12:00:00Z");

async function setupWindowedFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");

  // Current window — app-a: 2 assistant turns (300 tokens each).
  await writeJsonl(path.join(projectsDir, "C--dev-app-a", "cur.jsonl"), [
    userTurn("2026-04-25T10:00:00Z", "current work"),
    assistantTurn("2026-04-25T10:00:01Z", "doing", [{ id: "c1", name: "Read", input: { file_path: "/x" } }], 200, 100),
    assistantTurn("2026-04-25T10:00:02Z", "more", [{ id: "c2", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } }], 200, 100),
  ]);

  // Previous window — app-a: 1 assistant turn (150 tokens).
  await writeJsonl(path.join(projectsDir, "C--dev-app-a", "prev.jsonl"), [
    userTurn("2026-04-18T10:00:00Z", "previous work"),
    assistantTurn("2026-04-18T10:00:01Z", "old", [{ id: "p1", name: "Read", input: { file_path: "/y" } }], 100, 50),
  ]);

  // Before the previous window — must be excluded from BOTH summaries.
  await writeJsonl(path.join(projectsDir, "C--dev-app-a", "ancient.jsonl"), [
    userTurn("2026-04-01T10:00:00Z", "ancient"),
    assistantTurn("2026-04-01T10:00:01Z", "ancient", [], 999, 999),
  ]);

  // Current window — app-b: 1 assistant turn (450 tokens). For the project
  // filter test (filtering to app-a must drop this).
  await writeJsonl(path.join(projectsDir, "C--dev-app-b", "b-cur.jsonl"), [
    userTurn("2026-04-26T10:00:00Z", "b work"),
    assistantTurn("2026-04-26T10:00:01Z", "b", [], 300, 150),
  ]);

  return projectsDir;
}

async function reloadModules() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  delete (globalThis as { __usageCache?: unknown }).__usageCache;
  delete (globalThis as { __usageFileCache?: unknown }).__usageFileCache;
  delete (globalThis as { __usageAllSessionsInFlight?: unknown }).__usageAllSessionsInFlight;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    facade: await import("@/lib/data"),
    fromDb: await import("@/lib/data/usageFromDb"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-usage-compare-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalUseDb === undefined) delete process.env.MINDER_USE_DB;
  else process.env.MINDER_USE_DB = originalUseDb;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("compareUsageFromSql — window + delta math", () => {
  async function buildDb() {
    const projectsDir = await setupWindowedFixture();
    process.env.MINDER_USE_DB = "1";
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;
    await mods.ingest.reconcileAllSessions(db, { projectsDir });
    return { ...mods, db, projectsDir };
  }

  it("splits turns into the current and previous windows, excluding older data", async () => {
    const { fromDb, db } = await buildDb();
    const cmp = fromDb.compareUsageFromSql(db, "7d", undefined, undefined, undefined, NOW);
    assertComparable(cmp);

    // current: app-a (2 turns) + app-b (1 turn) = 3 turns across 2 sessions.
    expect(cmp.current.turns).toBe(3);
    expect(cmp.current.sessions).toBe(2);
    // previous: app-a prev session, 1 turn.
    expect(cmp.previous.turns).toBe(1);
    expect(cmp.previous.sessions).toBe(1);

    // Tokens: current = (300*2) + 450 = 1050; previous = 150. The 1998-token
    // ancient turn is in neither window.
    expect(cmp.current.tokens).toBe(1050);
    expect(cmp.previous.tokens).toBe(150);
  });

  it("computes absolute and relative deltas with the same injected instant", async () => {
    const { fromDb, db } = await buildDb();
    const cmp = fromDb.compareUsageFromSql(db, "7d", undefined, undefined, undefined, NOW);
    assertComparable(cmp);

    expect(cmp.deltas.sessions).toMatchObject({ current: 2, previous: 1, absolute: 1, pct: 1, basis: true });
    expect(cmp.deltas.tokens).toMatchObject({ current: 1050, previous: 150, absolute: 900, pct: 6 });
    expect(cmp.deltas.cost.absolute).toBeGreaterThan(0);
    expect(cmp.deltas.cost.pct).toBeGreaterThan(0);
  });

  it("emits the same instant for both window edges (previous.end === current.start)", async () => {
    const { fromDb, db } = await buildDb();
    const cmp = fromDb.compareUsageFromSql(db, "7d", undefined, undefined, undefined, NOW);
    assertComparable(cmp);
    expect(cmp.currentWindow.end).toBe(NOW.toISOString());
    expect(cmp.previousWindow.end).toBe(cmp.currentWindow.start);
  });

  it("leaves pct null when the previous window is empty (the 'new' case)", async () => {
    const { fromDb, db } = await buildDb();
    // 24h window ending at NOW: current = [04-29T12, 04-30T12), previous =
    // [04-28T12, 04-29T12). No fixture turns land in either window, so both
    // summaries are zero and every pct is null (0 → 0).
    const cmp = fromDb.compareUsageFromSql(db, "24h", undefined, undefined, undefined, NOW);
    assertComparable(cmp);
    expect(cmp.previous.cost).toBe(0);
    expect(cmp.deltas.cost.pct).toBeNull();
    expect(cmp.deltas.sessions.pct).toBeNull();
  });

  it("preserves equal-length windows for 'today' (partial day vs equal prior block)", async () => {
    const { fromDb, db } = await buildDb();
    // Mid-day instant. The honesty property: the previous window must be the
    // same elapsed length as the current partial-day window, and abut it —
    // never a full 24h day against a partial morning.
    const midday = new Date("2026-04-30T09:30:00Z");
    const cmp = fromDb.compareUsageFromSql(db, "today", undefined, undefined, undefined, midday);
    assertComparable(cmp);
    const curLen = new Date(cmp.currentWindow.end).getTime() - new Date(cmp.currentWindow.start).getTime();
    const prevLen = new Date(cmp.previousWindow.end).getTime() - new Date(cmp.previousWindow.start).getTime();
    expect(prevLen).toBe(curLen);
    expect(cmp.previousWindow.end).toBe(cmp.currentWindow.start);
  });

  it("handles an empty current window over a populated previous one", async () => {
    const { fromDb, db } = await buildDb();
    // Shift `now` forward so the current 7d window [04-28T12, 05-05T12) is
    // empty and the previous window [04-21T12, 04-28T12) captures the 04-25
    // and 04-26 turns (3 turns, 1050 tokens). The 04-18 turn precedes the
    // previous window and is excluded.
    const later = new Date("2026-05-05T12:00:00Z");
    const cmp = fromDb.compareUsageFromSql(db, "7d", undefined, undefined, undefined, later);
    assertComparable(cmp);

    expect(cmp.current.turns).toBe(0);
    expect(cmp.current.cost).toBe(0);
    expect(cmp.current.verifiedTasks).toBe(0);
    expect(cmp.previous.turns).toBe(3);
    expect(cmp.previous.tokens).toBe(1050);

    // A drop to zero is a real -100% on the volume metric (previous nonzero),
    // and a volume delta always carries basis:true.
    expect(cmp.deltas.tokens).toMatchObject({ current: 0, previous: 1050, absolute: -1050, pct: -1, basis: true });
    // The current window measured no rate at all — so the rate deltas carry
    // basis:false, the data-layer flag that tells every consumer to render a
    // neutral placeholder instead of a confident "-Xpp" against a 0-fallback.
    expect(cmp.deltas.oneShotRate.basis).toBe(false);
    expect(cmp.deltas.cacheHitRate.basis).toBe(false);
  });

  it("returns not-comparable for 'all' (no prior window)", async () => {
    const { fromDb, db } = await buildDb();
    const cmp = fromDb.compareUsageFromSql(db, "all", undefined, undefined, undefined, NOW);
    expect(cmp.comparable).toBe(false);
    if (!cmp.comparable) expect(cmp.reason).toBeTruthy();
  });

  it("threads the project filter into both windows", async () => {
    const { fromDb, db } = await buildDb();
    const slug = (
      db.prepare("SELECT project_slug FROM sessions WHERE project_dir_name = 'C--dev-app-a' LIMIT 1").get() as
        | { project_slug: string }
        | undefined
    )?.project_slug;
    expect(slug).toBeTruthy();

    const cmp = fromDb.compareUsageFromSql(db, "7d", slug, undefined, undefined, NOW);
    assertComparable(cmp);
    // app-b's current-window turn is dropped: current is app-a only (2 turns,
    // 600 tokens); previous is unchanged (1 turn, 150 tokens).
    expect(cmp.current.turns).toBe(2);
    expect(cmp.current.tokens).toBe(600);
    expect(cmp.previous.turns).toBe(1);
  });
});

describe.skipIf(!driverAvailable)("getUsageCompare — façade not-comparable branches", () => {
  it("returns not-comparable (file backend) when MINDER_USE_DB=0", async () => {
    await setupWindowedFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const { comparison, meta } = await facade.getUsageCompare("7d", undefined);
    expect(meta.backend).toBe("file");
    expect(comparison.comparable).toBe(false);
    if (!comparison.comparable) expect(comparison.reason).toMatch(/SQLite backend/i);
  });

  it("returns a comparable result against the live DB backend", async () => {
    const projectsDir = await setupWindowedFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir });

    const { comparison, meta } = await facade.getUsageCompare("7d", undefined);
    expect(meta.backend).toBe("db");
    assertComparable(comparison);
    expect(comparison.current).toBeTruthy();
    expect(comparison.deltas).toBeTruthy();
  });
});
