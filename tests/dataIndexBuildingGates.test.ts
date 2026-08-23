import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// #472 — the cross-corpus aggregates in `@/lib/data` must not answer from an
// index that is still filling for the first time.
//
// The state under test is the one the old gates could not see, and every case
// below constructs it the same deliberate way: run a real reconcile, but
// WITHOUT `recordRun`. That leaves the sessions table POPULATED and the
// readiness latch UNSET — precisely the shape a first pass has for nearly its
// whole duration, since `reconcileAllSessions` commits per file. A zero-rows
// test reads that as a healthy index and serves the subset; the build-state
// test reads it as building and falls back.
//
// So a fixture with rows in it is not incidental here — it is the
// discriminator. Seeding an EMPTY index instead would pass against the old
// zero-rows gate too, and prove nothing.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({
  prefix: "pm-building-gates-",
  extraGlobals: ["__usageCache", "__usageFileCache", "__sessionIndex", "__sessionsCache"],
  preserveEnv: ["MINDER_USE_DB", "MINDER_INDEXER"],
});

let tmpHome: string;

const SESSION_A = "aaaaaaaa-1111-2222-3333-444455556666";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444455556666";
const SESSION_C = "cccccccc-1111-2222-3333-444455556666";

function userTurn(timestamp: string, text: string) {
  return { type: "user" as const, timestamp, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(
  timestamp: string,
  model: string,
  text: string,
  toolCalls: Array<{ id: string; name: string; input: unknown }> = []
) {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  return {
    type: "assistant" as const,
    timestamp,
    message: {
      model,
      content,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Two sessions across two projects — enough that a partial answer is visibly partial. */
async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "fix the bug in the parser"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Looking at it", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/parser.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Dispatching", [
      {
        id: "tu_a2",
        name: "Agent",
        input: { subagent_type: "Explore", description: "scope it", prompt: "find the entrypoint" },
      },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "add a new feature"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-opus-4-7", "Designing", [
      { id: "tu_b1", name: "Glob", input: { pattern: "**/*.ts" } },
    ]),
  ]);
  return projectsDir;
}

async function reloadModules() {
  await state.reload();
  return {
    facade: await import("@/lib/data"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    runs: await import("@/lib/db/indexerRuns"),
  };
}

type Mods = Awaited<ReturnType<typeof reloadModules>>;

/** Record the completed pass that production's initial reconcile writes. */
function markReady(runs: Mods["runs"], db: Parameters<Mods["runs"]["beginIndexerRun"]>[0]): void {
  const id = runs.beginIndexerRun(db, "reconcile");
  runs.finishIndexerRun(db, id, { filesSeen: 0 });
}

/**
 * A populated index with no completed pass recorded against it — the half-built
 * shape. Returns the handles so a caller can then record a pass and re-ask.
 */
async function seedBuilding() {
  const projectsDir = await setupFixture();
  process.env.MINDER_USE_DB = "1";
  const mods = await reloadModules();
  const init = await mods.mig.initDb();
  expect(init.available).toBe(true);
  const db = (await mods.conn.getDb())!;
  // No `recordRun` — the corpus is read through, but nothing records that it was.
  assertReconcileClean(await mods.ingest.reconcileAllSessions(db, { projectsDir }));
  // Guard the premise: rows ARE present, so the old zero-rows gate would have
  // taken the DB branch here. If this ever reads 0 the tests below stop
  // discriminating and start passing for the wrong reason.
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  expect(n).toBeGreaterThan(0);
  expect(mods.runs.getIndexBuildState(db)).toBe("building");
  return { ...mods, db };
}

/**
 * Make a non-Claude session both enabled AND discoverable — the state in which
 * the file-parse fallback would silently drop a whole source. Returns a
 * restore function.
 */
async function mockDiscoverableCodexSession(
  projectDirName = "codexproj"
): Promise<() => void> {
  const configMod = await import("@/lib/config");
  const adaptersMod = await import("@/lib/adapters");
  const base = await configMod.readConfig();
  const cfgSpy = vi
    .spyOn(configMod, "readConfig")
    .mockResolvedValue({ ...base, enabledAdapters: ["claude", "codex"] });
  const discSpy = vi.spyOn(adaptersMod, "discoverAllSessions").mockResolvedValue([
    { source: "codex", filePath: path.join(tmpHome, "codex", "s1.jsonl"), projectDirName },
  ]);
  return () => {
    cfgSpy.mockRestore();
    discSpy.mockRestore();
  };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
  delete process.env.MINDER_INDEXER;
});

afterEach(() => {
  delete process.env.MINDER_INDEXER;
});

describe.skipIf(!driverAvailable)("data façade — half-built index gates (#472)", () => {
  it("serves the session list from file-parse while the first pass is still running", async () => {
    const { facade, runs, db } = await seedBuilding();

    const building = await facade.getSessionsList();
    expect(building.meta.backend).toBe("file");
    expect(building.sessions.length).toBe(2);

    // And hands the DB back the moment a pass is recorded — the latch is what
    // moves, not the row count, which is identical across these two calls.
    markReady(runs, db);
    const ready = await facade.getSessionsList();
    expect(ready.meta.backend).toBe("db");
    expect(ready.sessions.length).toBe(2);
  });

  it("does not report a token total from a partly-ingested corpus", async () => {
    // `getUsage` had no cold-index gate at all before #472 — not even the
    // zero-rows check its neighbours carried — so this window produced a
    // number that was not merely incomplete but wrong.
    const { facade, runs, db } = await seedBuilding();

    expect((await facade.getUsage("all", undefined)).meta.backend).toBe("file");
    markReady(runs, db);
    expect((await facade.getUsage("all", undefined)).meta.backend).toBe("db");
  });

  it("refuses to compare two windows of a half-built index", async () => {
    // There is no file-parse compare path, so this degrades instead of falling
    // back. Both windows would be subsets, which makes the delta between them
    // arbitrary — it would read as a real period-over-period swing.
    const { facade } = await seedBuilding();
    const { comparison } = await facade.getUsageCompare("7d");
    expect(comparison.comparable).toBe(false);
  });

  it("gates agent and skill usage on the build state for BOUNDED periods too", async () => {
    // The zero-rows guard is all-time-only on purpose (Codex P1, PR #113): an
    // empty week is a legitimate "no recent invocations" answer. Orthogonal —
    // an index that has never been read through cannot answer a 7-day question
    // either, so the build-state gate applies to every period.
    const { facade } = await seedBuilding();
    expect((await facade.getAgentUsage("7d")).meta.backend).toBe("file");
    expect((await facade.getSkillUsage("7d")).meta.backend).toBe("file");
  });

  it("still answers a bounded, empty window from the DB once the index is ready", async () => {
    // The #113 regression guard. The fixture's turns are dated 2026-04, so a
    // 24h window over a READY index is legitimately empty — and must stay on
    // the DB backend rather than paying a full JSONL walk per toggle click.
    const { facade, runs, db } = await seedBuilding();
    markReady(runs, db);
    const agents = await facade.getAgentUsage("24h");
    expect(agents.meta.backend).toBe("db");
    expect(agents.stats.length).toBe(0);
  });

  it("diverts the usage loaders for an adapter install, and not the session list", async () => {
    // This is the #475 split, and it is the whole point of that issue.
    //
    // BEFORE: `fileParseCoversCorpus` refused to divert ANY loader whenever
    // adapter sessions were discoverable, because file-parse saw Claude and
    // nothing else — so diverting would have traded a partial view of every
    // source for a complete view of one. The cost was that adapter users kept
    // the #472 defect on every surface.
    //
    // NOW: `buildAllSessions` merges enabled adapters (see
    // `usageParserAdapters.test.ts`, which proves the turns actually arrive), so
    // the usage loaders cover the corpus and divert like everyone else. The
    // session list does not: `scanAllSessions` has no adapter derivation, so it
    // still declines rather than showing an adapter user a Claude-only list.
    const { facade, conn } = await seedBuilding();
    const spies = await mockDiscoverableCodexSession();
    try {
      expect((await facade.getUsage("all", undefined)).meta.backend).toBe("file");
      expect((await facade.getAgentUsage()).meta.backend).toBe("file");
      expect((await facade.getSkillUsage()).meta.backend).toBe("file");
      // The one that is still Claude-only, and so still refuses.
      expect((await facade.getSessionsList()).meta.backend).toBe("db");
    } finally {
      spies();
      conn.closeDb();
    }
  });

  it("diverts a scoped usage request too, whatever the adapter corpus is", async () => {
    // The source/project qualification this gate used to carry existed so a
    // Claude-scoped or project-scoped request could divert while adapter
    // sessions sat elsewhere. Coverage makes the distinction moot: every scope
    // of the question is now answerable from file-parse, including one scoped to
    // the adapter's OWN source, which previously could never divert because
    // file-parse would have answered "no Codex usage" instead of "some".
    const { facade, conn } = await seedBuilding();
    const { toSlug } = await import("@/lib/scanner/claudeConversations");
    const spies = await mockDiscoverableCodexSession("C--dev-somewhere-else");
    try {
      expect((await facade.getUsage("all", undefined, "claude")).meta.backend).toBe("file");
      expect((await facade.getUsage("all", undefined, "codex")).meta.backend).toBe("file");
      expect((await facade.getUsage("all", toSlug("C--dev-app-x"))).meta.backend).toBe("file");
    } finally {
      spies();
      conn.closeDb();
    }
  });

  it("still degrades the comparison for an adapter install, which needs no corpus", async () => {
    // The trap in the fix above. `getUsageCompare` degrades to "not comparable"
    // rather than falling back, so the adapter question does not arise for it —
    // and folding the adapter check into the shared build-state predicate would
    // have quietly returned adapter users to comparing two DB subsets. The
    // defect, reintroduced by the fix for the defect.
    const { facade, conn } = await seedBuilding();
    const spies = await mockDiscoverableCodexSession();
    try {
      const { comparison } = await facade.getUsageCompare("7d");
      expect(comparison.comparable).toBe(false);
    } finally {
      spies();
      conn.closeDb();
    }
  });

  it("sweeps every configured Claude home when it falls back to file-parse", async () => {
    // `scanAllSessions` was hard-coded to `os.homedir()/.claude/projects` while
    // the indexer walked every configured home, so the fallback served a
    // secondary or WSL home's user an incomplete list — under `MINDER_USE_DB=0`
    // and during v3 catch-up before #472, and for the whole first reconcile
    // after it. (Codex P1, PR #474.)
    await setupFixture();
    const secondHome = path.join(tmpHome, "second-home", ".claude");
    await writeJsonl(
      path.join(secondHome, "projects", "C--dev-elsewhere", `${SESSION_C}.jsonl`),
      [
        userTurn("2026-04-17T12:00:00Z", "work in the other home"),
        assistantTurn("2026-04-17T12:00:01Z", "claude-sonnet-4-5", "On it"),
      ]
    );

    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const configMod = await import("@/lib/config");
    const base = await configMod.readConfig();
    const spy = vi
      .spyOn(configMod, "readConfig")
      .mockResolvedValue({ ...base, claudeHomes: [secondHome] });
    try {
      const result = await facade.getSessionsList();
      expect(result.meta.backend).toBe("file");
      // Both homes, not just the primary one.
      expect(result.sessions.map((s) => s.sessionId).sort()).toEqual(
        [SESSION_A, SESSION_B, SESSION_C].sort()
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the branch it took, not the branch it hoped for", async () => {
    // The predicate used to log "fell back to file-parse" before its callers had
    // decided anything, so the two paths that do NOT fall back — an adapter
    // install, and the comparison — both claimed one in the log. During the
    // first-build window, which is the only time an operator reads these lines,
    // that is worse than logging nothing. (Copilot, PR #474.)
    const { facade, conn } = await seedBuilding();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Ordinary case: it really does fall back, and says so.
      await facade.getSessionsList();
      expect(warn.mock.calls.flat().join("\n")).toContain("fell back to file-parse");

      warn.mockClear();
      // Compare degrades instead — no fallback claim.
      await facade.getUsageCompare("7d");
      const compareLog = warn.mock.calls.flat().join("\n");
      expect(compareLog).toContain("comparison suppressed");
      expect(compareLog).not.toContain("fell back to file-parse");

      warn.mockClear();
      const spies = await mockDiscoverableCodexSession();
      try {
        // The session list is the loader that still declines (#475) — it must
        // not claim a fallback it did not take.
        await facade.getSessionsList();
        const adapterLog = warn.mock.calls.flat().join("\n");
        expect(adapterLog).not.toContain("fell back to file-parse");
        expect(adapterLog).toContain("serving the SQL answer");

        warn.mockClear();
        // And the usage loader, which now covers the corpus, really does fall
        // back — so it must say so rather than inheriting the list's silence.
        await facade.getUsage("all", undefined);
        expect(warn.mock.calls.flat().join("\n")).toContain("fell back to file-parse");
      } finally {
        spies();
      }
    } finally {
      warn.mockRestore();
      conn.closeDb();
    }
  });

  it("keeps the zero-rows fallback alive when the indexer is switched off", async () => {
    // The trap in making this gate a REPLACEMENT rather than an addition. With
    // `MINDER_INDEXER=0` nothing will ever record a pass, so
    // `getIndexBuildState` reports "ready" permanently and the build-state gate
    // can never fire. Had the zero-rows checks been removed in its favour, the
    // dashboard would serve an empty list forever to exactly the operators who
    // switched ingest off.
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    process.env.MINDER_INDEXER = "0";
    const { facade, mig, conn, ingest, runs } = await reloadModules();
    expect((await mig.initDb()).available).toBe(true);
    const db = (await conn.getDb())!;

    // Reconcile an EMPTY tree, not the fixture. That is what isolates the check
    // under test: a pass over zero files still clears the v3 readiness gate, so
    // the index arrives at the zero-rows check instead of being diverted before
    // it. (Skipping the reconcile entirely leaves the v3 gate set, and the v3
    // fallback — not this one — is what would answer.)
    const emptyTree = path.join(tmpHome, "empty-projects");
    await fs.mkdir(emptyTree, { recursive: true });
    assertReconcileClean(await ingest.reconcileAllSessions(db, { projectsDir: emptyTree }));
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n
    ).toBe(0);
    // Permanently, because nothing will ever record a pass in this mode.
    expect(runs.getIndexBuildState(db)).toBe("ready");

    const result = await facade.getSessionsList();
    expect(result.meta.backend).toBe("file");
    expect(result.sessions.length).toBe(2);
  });
});
