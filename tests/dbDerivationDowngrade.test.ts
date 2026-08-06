import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { DERIVED_VERSION } from "@/lib/db/derivationVersion";
import type { UsageTurn } from "@/lib/usage/types";

/**
 * Regression: an OLDER build must never rewrite rows derived by a NEWER one.
 *
 * On 2026-08-05 a tray packaged 2026-08-03 (`DERIVED_VERSION = 12`) started
 * ~30 minutes after a v14 re-index and reverted all 5,001 sessions, discarding
 * 22,682 `turns.effort` values and 1,141 `task_outcome` stamps. The staleness
 * gates compared `stored === DERIVED_VERSION`, which is false in BOTH
 * directions, so "newer" was indistinguishable from "stale" and the newer rows
 * were re-derived downward. It reported `errors: 0`.
 *
 * The tests below stamp a session as if a newer build had written it — a
 * bumped `derived_version` plus a sentinel in `ai_title`, standing in for any
 * column this build doesn't know how to produce — and assert the reconcile
 * leaves both alone.
 */

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

interface Reloaded {
  conn: typeof import("@/lib/db/connection");
  mig: typeof import("@/lib/db/migrations");
  ingest: typeof import("@/lib/db/ingest");
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function reloadModulesPointingAt(home: string): Promise<Reloaded> {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  return { conn, mig, ingest };
}

function userTurn(timestamp: string, text: string) {
  return { type: "user", timestamp, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(timestamp: string, text: string) {
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
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

async function appendJsonl(filePath: string, entries: unknown[]): Promise<void> {
  await fs.appendFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-downgrade-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const SENTINEL = "written-by-a-newer-build";

describe.skipIf(!driverAvailable)("derived_version downgrade protection", () => {
  async function setupWithSession() {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();

    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const sessionFile = path.join(projectsDir, "C--dev-myapp", "sess-1.jsonl");
    await writeJsonl(sessionFile, [
      userTurn("2026-08-05T10:00:00Z", "do the thing"),
      assistantTurn("2026-08-05T10:00:01Z", "done"),
    ]);

    const db = await reloaded.conn.getDb();
    expect(db).not.toBeNull();
    await reloaded.ingest.reconcileAllSessions(db!, {});

    const row = db!
      .prepare("SELECT session_id, derived_version FROM sessions")
      .get() as { session_id: string; derived_version: number };
    expect(row.derived_version).toBe(DERIVED_VERSION);

    // Pose as a newer build's output: bump the version and plant a value in a
    // column this build has no way to regenerate from the fixture.
    db!
      .prepare("UPDATE sessions SET derived_version = ?, ai_title = ? WHERE session_id = ?")
      .run(DERIVED_VERSION + 1, SENTINEL, row.session_id);

    return { reloaded, db: db!, sessionFile, sessionId: row.session_id };
  }

  function readBack(db: import("better-sqlite3").Database, sessionId: string) {
    return db
      .prepare("SELECT derived_version, ai_title FROM sessions WHERE session_id = ?")
      .get(sessionId) as { derived_version: number; ai_title: string | null } | undefined;
  }

  it("leaves a newer-derived session alone when the file is unchanged", async () => {
    const { reloaded, db, sessionId } = await setupWithSession();

    const stats = await reloaded.ingest.reconcileAllSessions(db, {});

    const after = readBack(db, sessionId);
    expect(after?.derived_version).toBe(DERIVED_VERSION + 1);
    expect(after?.ai_title).toBe(SENTINEL);
    expect(stats.newerDerivationSkips).toBe(1);
  });

  /**
   * The case that actually caused the loss. The unchanged-file gate requires
   * mtime AND size to match, so a session that merely GREW — every active
   * session — skipped past it, failed `derived_version === DERIVED_VERSION`,
   * and fell through to a full replace. A fix applied only to the no-op gate
   * would pass the test above and still destroy data here.
   */
  it("leaves a newer-derived session alone when the file has GROWN", async () => {
    const { reloaded, db, sessionFile, sessionId } = await setupWithSession();

    await appendJsonl(sessionFile, [
      userTurn("2026-08-05T10:05:00Z", "and another thing"),
      assistantTurn("2026-08-05T10:05:01Z", "also done"),
    ]);

    const stats = await reloaded.ingest.reconcileAllSessions(db, {});

    const after = readBack(db, sessionId);
    expect(after?.derived_version).toBe(DERIVED_VERSION + 1);
    expect(after?.ai_title).toBe(SENTINEL);
    expect(stats.newerDerivationSkips).toBe(1);

    // And the newer rows were not partially overwritten: the appended turns
    // must NOT have been tail-appended at this build's version either, since
    // mixing v(N) turns into a v(N+1) session is its own corruption.
    const turnVersions = db
      .prepare(
        "SELECT COUNT(*) AS n FROM turns WHERE session_id = ?"
      )
      .get(sessionId) as { n: number };
    expect(turnVersions.n).toBe(2); // still just the original two turns
  });

  /**
   * The guard must not break the reason the gate exists. An OLDER stored
   * version still has to re-derive, or `>=` would freeze every index at
   * whatever version wrote it first.
   */
  it("still re-derives a session stamped at an OLDER version", async () => {
    const { reloaded, db, sessionId } = await setupWithSession();

    db.prepare("UPDATE sessions SET derived_version = ? WHERE session_id = ?").run(
      DERIVED_VERSION - 1,
      sessionId
    );

    const stats = await reloaded.ingest.reconcileAllSessions(db, {});

    const after = readBack(db, sessionId);
    expect(after?.derived_version).toBe(DERIVED_VERSION);
    expect(after?.ai_title).toBeNull(); // re-derived from the fixture, sentinel gone
    expect(stats.newerDerivationSkips).toBe(0);
  });

  /**
   * `force` stays the escape hatch. None of the watcher's three call sites
   * pass it, so this cannot fire on the automatic path — but a deliberately
   * rolled-back install needs some way to re-derive rather than being stuck
   * with rows it can never rewrite.
   */
  it("force overrides the guard and re-derives at this version", async () => {
    const { reloaded, db, sessionId } = await setupWithSession();

    const stats = await reloaded.ingest.reconcileAllSessions(db, { force: true });

    const after = readBack(db, sessionId);
    expect(after?.derived_version).toBe(DERIVED_VERSION);
    expect(after?.ai_title).toBeNull();
    expect(stats.newerDerivationSkips).toBe(0);
  });
});

/**
 * The adapter (Codex/Gemini) path is a SEPARATE function with its own gate.
 * A test covering only the Claude path says nothing about it — that exact gap
 * shipped a real bug in A2, where adapter sessions never got their
 * `task_outcome` stamped and the Claude-only parity test stayed green.
 *
 * Adapter files have no tail-append path: any change is a full re-parse and
 * replace, so an unchanged file is enough to exercise the downgrade.
 */
describe.skipIf(!driverAvailable)("derived_version downgrade protection — adapter path", () => {
  function cfg(enabledAdapters: string[]) {
    return { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters };
  }

  it("leaves a newer-derived adapter session alone", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();
    const db = (await reloaded.conn.getDb())!;

    const codexPath = path.join(tmpHome, ".codex", "sessions", "r1.jsonl");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "{}\n");

    const adapterSessions = [
      { source: "codex" as const, filePath: codexPath, projectDirName: "codexproj" },
    ];
    const parseAdapterFile = vi.fn(async (): Promise<UsageTurn[]> => [
      {
        timestamp: "2026-08-05T10:00:00Z", sessionId: "cx-1",
        projectSlug: "codexproj", projectDirName: "codexproj",
        model: "", role: "user", inputTokens: 0, outputTokens: 0,
        cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], userMessageText: "hello",
      },
      {
        timestamp: "2026-08-05T10:00:01Z", sessionId: "cx-1",
        projectSlug: "codexproj", projectDirName: "codexproj",
        model: "gpt-5", role: "assistant", inputTokens: 200, outputTokens: 100,
        cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], assistantText: "hi",
      },
    ]);

    const opts = {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
      config: cfg(["claude", "codex"]),
      adapterSessions,
      parseAdapterFile,
    } as Parameters<typeof reloaded.ingest.reconcileAllSessions>[1];

    await reloaded.ingest.reconcileAllSessions(db, opts);
    const seeded = db
      .prepare("SELECT session_id, derived_version FROM sessions WHERE source = 'codex'")
      .get() as { session_id: string; derived_version: number } | undefined;
    expect(seeded).toBeDefined();
    expect(seeded!.derived_version).toBe(DERIVED_VERSION);

    db.prepare("UPDATE sessions SET derived_version = ?, ai_title = ? WHERE session_id = ?").run(
      DERIVED_VERSION + 1,
      SENTINEL,
      seeded!.session_id
    );

    const stats = await reloaded.ingest.reconcileAllSessions(db, opts);

    const after = db
      .prepare("SELECT derived_version, ai_title FROM sessions WHERE session_id = ?")
      .get(seeded!.session_id) as { derived_version: number; ai_title: string | null };
    expect(after.derived_version).toBe(DERIVED_VERSION + 1);
    expect(after.ai_title).toBe(SENTINEL);
    expect(stats.newerDerivationSkips).toBe(1);
    reloaded.conn.closeDb();
  });

  /**
   * The prune pass is the OTHER way an old build destroys newer rows, and the
   * reconcile guard does not cover it (Codex review, PR #381).
   *
   * Reachable path: roll back across a build that added an adapter.
   * `getEnabledAdapters` skips an unknown configured id with only a
   * `console.warn`, so discovery *succeeds* having found none of that
   * adapter's files — `adapterDiscoveryFailed` stays false and the
   * shield-on-failure never engages. Those already-indexed sessions are then
   * missing from `liveFilePaths` and are indistinguishable from vanished
   * files, so the prune deletes them outright. Deleting newer rows is strictly
   * worse than the downgrade this PR set out to stop.
   *
   * Simulated by reconciling with the adapter session absent from discovery,
   * which is exactly the state an unknown-adapter rollback produces.
   */
  it("does not PRUNE a newer-derived session that discovery no longer returns", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();
    const db = (await reloaded.conn.getDb())!;

    const codexPath = path.join(tmpHome, ".codex", "sessions", "r2.jsonl");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "{}\n");

    const parseAdapterFile = vi.fn(async (): Promise<UsageTurn[]> => [
      {
        timestamp: "2026-08-05T10:00:00Z", sessionId: "cx-2",
        projectSlug: "codexproj", projectDirName: "codexproj",
        model: "", role: "user", inputTokens: 0, outputTokens: 0,
        cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], userMessageText: "hello",
      },
      {
        timestamp: "2026-08-05T10:00:01Z", sessionId: "cx-2",
        projectSlug: "codexproj", projectDirName: "codexproj",
        model: "gpt-5", role: "assistant", inputTokens: 200, outputTokens: 100,
        cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], assistantText: "hi",
      },
    ]);

    const base = {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
      config: cfg(["claude", "codex"]),
      parseAdapterFile,
    };

    // Index it while the adapter is known.
    await reloaded.ingest.reconcileAllSessions(db, {
      ...base,
      adapterSessions: [
        { source: "codex" as const, filePath: codexPath, projectDirName: "codexproj" },
      ],
    } as Parameters<typeof reloaded.ingest.reconcileAllSessions>[1]);

    const seeded = db
      .prepare("SELECT session_id FROM sessions WHERE source = 'codex'")
      .get() as { session_id: string } | undefined;
    expect(seeded).toBeDefined();

    db.prepare("UPDATE sessions SET derived_version = ? WHERE session_id = ?").run(
      DERIVED_VERSION + 1,
      seeded!.session_id
    );

    // Now the older build: the adapter is unknown, so discovery returns an
    // EMPTY list without failing. The file is still on disk.
    const stats = await reloaded.ingest.reconcileAllSessions(db, {
      ...base,
      adapterSessions: [],
    } as Parameters<typeof reloaded.ingest.reconcileAllSessions>[1]);

    const survivor = db
      .prepare("SELECT derived_version FROM sessions WHERE session_id = ?")
      .get(seeded!.session_id) as { derived_version: number } | undefined;
    expect(survivor).toBeDefined();
    expect(survivor!.derived_version).toBe(DERIVED_VERSION + 1);
    // Its turns must survive too — the delete cascades.
    const turns = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?")
      .get(seeded!.session_id) as { n: number };
    expect(turns.n).toBeGreaterThan(0);
    expect(stats.newerDerivationSkips).toBeGreaterThanOrEqual(1);
    reloaded.conn.closeDb();
  });

  it("still prunes a vanished session derived at THIS version", async () => {
    const reloaded = await reloadModulesPointingAt(tmpHome);
    const init = await reloaded.mig.initDb();
    expect(init.error).toBeNull();
    const db = (await reloaded.conn.getDb())!;

    const codexPath = path.join(tmpHome, ".codex", "sessions", "r3.jsonl");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "{}\n");

    const parseAdapterFile = vi.fn(async (): Promise<UsageTurn[]> => [
      {
        timestamp: "2026-08-05T10:00:01Z", sessionId: "cx-3",
        projectSlug: "codexproj", projectDirName: "codexproj",
        model: "gpt-5", role: "assistant", inputTokens: 200, outputTokens: 100,
        cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], assistantText: "hi",
      },
    ]);
    const base = {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
      config: cfg(["claude", "codex"]),
      parseAdapterFile,
    };

    await reloaded.ingest.reconcileAllSessions(db, {
      ...base,
      adapterSessions: [
        { source: "codex" as const, filePath: codexPath, projectDirName: "codexproj" },
      ],
    } as Parameters<typeof reloaded.ingest.reconcileAllSessions>[1]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(1);

    // Same-version rows must still be pruned, or the guard would freeze every
    // deletion and the index would grow forever.
    await reloaded.ingest.reconcileAllSessions(db, {
      ...base,
      adapterSessions: [],
    } as Parameters<typeof reloaded.ingest.reconcileAllSessions>[1]);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE source='codex'").get() as { n: number }).n
    ).toBe(0);
    reloaded.conn.closeDb();
  });
});
