import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

/**
 * A6 — hook performance + permission/denial analytics.
 *
 * The headline finding is a dead feature, not a new one. `session_hook_runs`
 * had **zero rows** on a fully-reconciled 1.5 GB index, because both readers
 * looked for `hookInfos` on the wrong entry type:
 *
 *   - `ingest.ts` decoded it ~40 lines below `if (entry.type === "system")
 *     { … continue; }`, under a comment asserting hook runs "ride assistant
 *     entries";
 *   - `claudeConversations.ts` decoded it *inside* the assistant branch.
 *
 * Measured across the local corpus, `hookInfos` rides `type:"system"` entries
 * on 4,189 of 4,189 carriers and assistant entries on **zero**. So the block
 * could never fire on either backend — and because both were wrong the same
 * way, dual-backend parity held perfectly, at zero.
 *
 * Nothing errored. An empty latency table reads exactly like "no hooks
 * configured", which is why it survived a full slice that shipped the table.
 */

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const SESSION = "aaaaaaaa-4444-4444-4444-4444a6a6a6a6";
const PROJECT_DIR = "C--dev-a6-demo";

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;

/**
 * A system entry shaped exactly like the real ones: `hookInfos` with a mix of
 * measured and unmeasured commands, a sibling `hookErrors` array of plain
 * strings, and `preventedContinuation`.
 */
function hookSystemEntry(ts: string) {
  return {
    type: "system",
    timestamp: ts,
    hookCount: 3,
    hookInfos: [
      { command: "codegraph sync", durationMs: 4174 },
      { command: "node ./stop-gate.mjs", durationMs: 1745 },
      // Real and common: a command with no duration. Must count as a fire but
      // not as 0 ms.
      { command: "bash ./security_reminder.sh" },
    ],
    hookErrors: ["Failed with non-blocking status code: CodeGraph not initialized"],
    preventedContinuation: false,
  };
}

function fixtureEntries(): unknown[] {
  return [
    { type: "user", timestamp: "2026-08-01T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    hookSystemEntry("2026-08-01T12:00:01Z"),
    {
      type: "assistant",
      timestamp: "2026-08-01T12:00:02Z",
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
}

async function writeFixture(): Promise<void> {
  const file = path.join(tmpHome, ".claude", "projects", PROJECT_DIR, `${SESSION}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, fixtureEntries().map((e) => JSON.stringify(e)).join("\n") + "\n");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalStateDir = process.env.MINDER_STATE_DIR;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-a6-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MINDER_STATE_DIR = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalStateDir === undefined) delete process.env.MINDER_STATE_DIR;
  else process.env.MINDER_STATE_DIR = originalStateDir;
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

describe("A6 — hook decode, file-parse backend", () => {
  it("finds hook runs on system entries", async () => {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === SESSION);
    expect(s).toBeDefined();
    expect(s!.hookRuns?.map((h) => h.command)).toEqual([
      "codegraph sync",
      "node ./stop-gate.mjs",
      "bash ./security_reminder.sh",
    ]);
  });

  it("keeps an unmeasured hook's duration undefined, not zero", async () => {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === SESSION);
    const unmeasured = s!.hookRuns!.find((h) => h.command.startsWith("bash "));
    // 0 would rank it as the fastest hook in the list.
    expect(unmeasured!.durationMs).toBeUndefined();
    expect(s!.hookRuns!.find((h) => h.command === "codegraph sync")!.durationMs).toBe(4174);
  });

  it("decodes hook errors and whether they blocked the turn", async () => {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === SESSION);
    expect(s!.hookErrors).toHaveLength(1);
    expect(s!.hookErrors![0].message).toContain("CodeGraph not initialized");
    expect(s!.hookErrors![0].preventedContinuation).toBe(false);
  });
});

describe.runIf(driverAvailable)("A6 — hook decode, SQLite backend", () => {
  async function ingest() {
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    expect(db).not.toBeNull();
    const ingestMod = await import("@/lib/db/ingest");
    await ingestMod.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });
    return db!;
  }

  it("writes hook runs to session_hook_runs", async () => {
    await writeFixture();
    const db = await ingest();
    const rows = db
      .prepare("SELECT command, duration_ms FROM session_hook_runs ORDER BY rowid")
      .all() as Array<{ command: string; duration_ms: number | null }>;
    // This table was empty on a fully-reconciled production index.
    expect(rows.map((r) => r.command)).toEqual([
      "codegraph sync",
      "node ./stop-gate.mjs",
      "bash ./security_reminder.sh",
    ]);
    expect(rows[2].duration_ms).toBeNull();
  });

  it("writes hook errors with their blocking flag", async () => {
    await writeFixture();
    const db = await ingest();
    const rows = db
      .prepare("SELECT message, prevented_continuation FROM session_hook_errors")
      .all() as Array<{ message: string; prevented_continuation: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].prevented_continuation).toBe(0);
  });

  it("agrees with the file backend on commands and durations", async () => {
    await writeFixture();
    const db = await ingest();
    const dbRuns = (
      db.prepare("SELECT command, duration_ms FROM session_hook_runs ORDER BY rowid").all() as Array<{
        command: string;
        duration_ms: number | null;
      }>
    ).map((r) => [r.command, r.duration_ms ?? undefined]);

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const s = (await scanAllSessions()).find((x) => x.sessionId === SESSION);
    const fileRuns = s!.hookRuns!.map((h) => [h.command, h.durationMs]);

    // Parity previously held at zero on both sides, which is why it never
    // caught this. It has to hold at a non-zero value to mean anything.
    expect(dbRuns).toEqual(fileRuns);
    expect(dbRuns.length).toBeGreaterThan(0);
  });

  it("serves hook latency from transcripts when OTEL has no events", async () => {
    await writeFixture();
    await ingest();
    const { getHookActivity } = await import("@/lib/db/otelQueries");
    const result = await getHookActivity({ since: Date.parse("2026-01-01T00:00:00Z") });
    expect(result.hasData).toBe(true);
    expect(result.source).toBe("transcript");
    const codegraph = result.hooks.find((h) => h.name === "codegraph sync");
    expect(codegraph?.fires).toBe(1);
    expect(codegraph?.p50DurationMs).toBe(4174);
    // The unmeasured hook still counts as a fire and reports NO percentile.
    // Codex + Copilot review of #386: returning 0 here contradicted this
    // slice's own headline principle and would rank the hook nobody timed as
    // the fastest on the machine.
    const unmeasured = result.hooks.find((h) => h.name.startsWith("bash "));
    expect(unmeasured?.fires).toBe(1);
    expect(unmeasured?.measuredFires).toBe(0);
    expect(unmeasured?.p50DurationMs).toBeUndefined();
    expect(unmeasured?.p95DurationMs).toBeUndefined();
    expect(codegraph?.measuredFires).toBe(1);
  });
});

// ── Denial breakdown ─────────────────────────────────────────────────────────

describe.runIf(driverAvailable)("A6 — denial breakdown crossed with task outcome", () => {
  it("reports hasData=false rather than an empty clean bill of health", async () => {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingestMod = await import("@/lib/db/ingest");
    await ingestMod.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    const { getDenialBreakdown } = await import("@/lib/data/denialAnalyticsFromDb");
    const result = await getDenialBreakdown();
    // No denial was recorded in this fixture. That must be distinguishable
    // from "denials exist and all is well".
    expect(result.hasData).toBe(false);
    expect(result.kinds).toEqual([]);
  });

  it("reports hasData for a quiet period when denials exist elsewhere in the index", async () => {
    // `hasData` answers "can this index speak about denials at all". Deriving
    // it from period-filtered rows made an ordinary quiet week read as "denials
    // were never recorded" — a claim about the schema, not the week (Copilot
    // review of #386).
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingestMod = await import("@/lib/db/ingest");
    await ingestMod.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });
    const turn = db!
      .prepare("SELECT turn_index FROM turns WHERE session_id = ? AND role = 'assistant' LIMIT 1")
      .get(SESSION) as { turn_index: number };
    db!.prepare(
      `INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_use_id, ts, tool_name, denial_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(SESSION, turn.turn_index, 95, "tu_old", "2020-01-01T00:00:00Z", "Bash", "permission-rule");

    const { getDenialBreakdown } = await import("@/lib/data/denialAnalyticsFromDb");
    const result = await getDenialBreakdown({ since: "2026-01-01T00:00:00Z" });
    expect(result.kinds).toEqual([]);
    // Empty window, but the index plainly can answer the question.
    expect(result.hasData).toBe(true);
  });

  it("groups by kind and counts a multi-denial turn's task once", async () => {
    await writeFixture();
    vi.resetModules();
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingestMod = await import("@/lib/db/ingest");
    await ingestMod.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    // Stage a turn with TWO calls denied the same way, against one recorded
    // task outcome. Without DISTINCT on (session, turn) the single task is
    // counted twice — and because both numerator and denominator double, the
    // RATE still looks correct while the sample size is fiction.
    db!.prepare(
      "UPDATE turns SET task_outcome = 'one_shot' WHERE session_id = ? AND role = 'assistant'"
    ).run(SESSION);
    const turn = db!
      .prepare("SELECT turn_index FROM turns WHERE session_id = ? AND role = 'assistant' LIMIT 1")
      .get(SESSION) as { turn_index: number };
    const ins = db!.prepare(
      `INSERT INTO tool_uses (session_id, turn_index, sequence_in_turn, tool_use_id, ts, tool_name, denial_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run(SESSION, turn.turn_index, 90, "tu_d1", "2026-08-01T12:00:02Z", "Bash", "permission-rule");
    ins.run(SESSION, turn.turn_index, 91, "tu_d2", "2026-08-01T12:00:02Z", "Bash", "permission-rule");
    ins.run(SESSION, turn.turn_index, 92, "tu_d3", "2026-08-01T12:00:02Z", "Edit", "user-rejected");

    const { getDenialBreakdown } = await import("@/lib/data/denialAnalyticsFromDb");
    const result = await getDenialBreakdown();

    expect(result.hasData).toBe(true);
    expect(result.totalDenials).toBe(3);

    const rule = result.kinds.find((k) => k.kind === "permission-rule")!;
    expect(rule.denials).toBe(2);
    // The cross: one turn, one task — not two.
    expect(rule.verifiedTasks).toBe(1);
    expect(rule.oneShotTasks).toBe(1);
    expect(rule.topTools[0]).toEqual({ tool: "Bash", denials: 2 });

    // Kept separate from rule denials on purpose: one is configuration, the
    // other is a human disagreeing.
    const rejected = result.kinds.find((k) => k.kind === "user-rejected")!;
    expect(rejected.denials).toBe(1);
  });
});
