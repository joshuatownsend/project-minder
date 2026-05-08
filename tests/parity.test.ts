/**
 * Parity gate for Commit 3 (Wave 8.3).
 *
 * Same JSONL fixture is parsed by:
 *   (A) DB path — reconcileSessionFile → SELECT from tool_uses / sessions
 *   (B) File-parse path — parseSessionTurns → ToolCall[].isError / errorCategory / invocationSource
 *
 * Both paths must produce equivalent results for the three new fields.
 * workMode parity is verified by comparing the DB sessions columns against
 * the output of aggregateWorkMode(classifyTurn(...)) on the parsed turns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

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

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-parity-test-"));
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
  } catch { /* ignore */ }
});

async function writeFixture(filePath: string, entries: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Build the JSONL fixture that exercises all three new fields. */
function buildFixture() {
  return [
    // User turn 1: slash-command invocation + tool_result for Bash (not error)
    {
      type: "user",
      timestamp: "2026-05-01T10:00:00Z",
      message: {
        content: [{ type: "text", text: "<command-name>gsd-debug</command-name>\nDebug the session" }],
      },
    },
    // Assistant turn 1: Skill (slash_command) + Bash (auto) + Read (auto)
    {
      type: "assistant",
      timestamp: "2026-05-01T10:00:01Z",
      message: {
        model: "claude-sonnet-4-5",
        content: [
          { type: "tool_use", id: "tu_skill", name: "Skill", input: { skill: "gsd-debug" } },
          { type: "tool_use", id: "tu_bash", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", id: "tu_read", name: "Read", input: { file_path: "/src/foo.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    // User turn 2: tool_results — bash succeeds, read fails with ENOENT
    {
      type: "user",
      timestamp: "2026-05-01T10:00:02Z",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_skill", content: "skill launched" },
          { type: "tool_result", tool_use_id: "tu_bash", content: "All tests pass" },
          { type: "tool_result", tool_use_id: "tu_read", is_error: true, content: "ENOENT: no such file or directory, open '/src/foo.ts'" },
        ],
      },
    },
    // Assistant turn 2: plain coding turn (no slash command from prior user turn)
    {
      type: "assistant",
      timestamp: "2026-05-01T10:00:03Z",
      message: {
        model: "claude-sonnet-4-5",
        content: [
          { type: "tool_use", id: "tu_edit", name: "Edit", input: { file_path: "/src/bar.ts", old_string: "a", new_string: "b" } },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 150, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    // User turn 3: tool_result for edit (succeeds)
    {
      type: "user",
      timestamp: "2026-05-01T10:00:04Z",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu_edit", content: "File updated" },
        ],
      },
    },
  ];
}

describe.skipIf(!driverAvailable)("Commit 3 parity: DB path vs file-parse path", () => {
  it("tool_uses.is_error, error_category, invocation_source match ToolCall fields", async () => {
    // ── Setup ──────────────────────────────────────────────────────────
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    const conn = await import("@/lib/db/connection");
    const mig = await import("@/lib/db/migrations");
    const ingest = await import("@/lib/db/ingest");
    const { parseSessionTurns } = await import("@/lib/usage/parser");

    const init = await mig.initDb();
    expect(init.available).toBe(true);
    const db = (await conn.getDb())!;

    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const sessionFile = path.join(projectsDir, "C--dev-myapp", "parity-session.jsonl");
    await writeFixture(sessionFile, buildFixture());

    // ── DB path ────────────────────────────────────────────────────────
    const result = await ingest.reconcileSessionFile(db, sessionFile, "C--dev-myapp");
    expect(result.rowsWritten).toBeGreaterThan(0);

    const dbToolUses = db
      .prepare("SELECT tool_use_id, is_error, error_category, invocation_source FROM tool_uses WHERE session_id = 'parity-session' ORDER BY sequence_in_turn")
      .all() as Array<{ tool_use_id: string; is_error: number; error_category: string | null; invocation_source: string | null }>;

    // 4 tool uses total: tu_skill, tu_bash, tu_read (turn1) + tu_edit (turn2)
    expect(dbToolUses).toHaveLength(4);

    const dbByTuId = Object.fromEntries(dbToolUses.map((r) => [r.tool_use_id, r]));

    // tu_skill: slash_command (matches <command-name>gsd-debug</command-name>), no error
    expect(dbByTuId["tu_skill"].is_error).toBe(0);
    expect(dbByTuId["tu_skill"].error_category).toBeNull();
    expect(dbByTuId["tu_skill"].invocation_source).toBe("slash_command");

    // tu_bash: auto (window consumed by Skill), no error
    expect(dbByTuId["tu_bash"].is_error).toBe(0);
    expect(dbByTuId["tu_bash"].error_category).toBeNull();
    expect(dbByTuId["tu_bash"].invocation_source).toBe("auto");

    // tu_read: auto, error (ENOENT → not-found)
    expect(dbByTuId["tu_read"].is_error).toBe(1);
    expect(dbByTuId["tu_read"].error_category).toBe("not-found");
    expect(dbByTuId["tu_read"].invocation_source).toBe("auto");

    // tu_edit: auto (no slash commands in prior user turn 3), no error
    expect(dbByTuId["tu_edit"].is_error).toBe(0);
    expect(dbByTuId["tu_edit"].error_category).toBeNull();
    expect(dbByTuId["tu_edit"].invocation_source).toBe("auto");

    // ── File-parse path ────────────────────────────────────────────────
    const fpTurns = await parseSessionTurns(sessionFile, "C--dev-myapp");
    const fpAssistantTurns = fpTurns.filter((t) => t.role === "assistant");
    expect(fpAssistantTurns).toHaveLength(2);

    // Turn 1 tool calls
    const [fpSkill, fpBash, fpRead] = fpAssistantTurns[0].toolCalls;
    expect(fpSkill.invocationSource).toBe("slash_command");
    expect(fpSkill.isError).toBeFalsy();

    expect(fpBash.invocationSource).toBe("auto");
    expect(fpBash.isError).toBeFalsy();

    expect(fpRead.invocationSource).toBe("auto");
    expect(fpRead.isError).toBe(true);
    expect(fpRead.errorCategory).toBe("not-found");

    // Turn 2 tool calls
    const [fpEdit] = fpAssistantTurns[1].toolCalls;
    expect(fpEdit.invocationSource).toBe("auto");
    expect(fpEdit.isError).toBeFalsy();
  });

  it("sessions.work_mode_*_pct populated and non-negative", async () => {
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);

    const conn = await import("@/lib/db/connection");
    const mig = await import("@/lib/db/migrations");
    const ingest = await import("@/lib/db/ingest");
    const { aggregateWorkMode } = await import("@/lib/usage/workMode");
    const { classifyTurn } = await import("@/lib/usage/classifier");
    const { parseSessionTurns } = await import("@/lib/usage/parser");

    const init = await mig.initDb();
    expect(init.available).toBe(true);
    const db = (await conn.getDb())!;

    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const sessionFile = path.join(projectsDir, "C--dev-myapp", "wm-session.jsonl");
    await writeFixture(sessionFile, buildFixture());

    await ingest.reconcileSessionFile(db, sessionFile, "C--dev-myapp");

    const dbSession = db
      .prepare("SELECT work_mode_exploration_pct, work_mode_building_pct, work_mode_testing_pct, work_mode_other_pct FROM sessions WHERE session_id = 'wm-session'")
      .get() as { work_mode_exploration_pct: number | null; work_mode_building_pct: number | null; work_mode_testing_pct: number | null; work_mode_other_pct: number | null };

    expect(dbSession.work_mode_exploration_pct).not.toBeNull();
    expect(dbSession.work_mode_building_pct).not.toBeNull();
    expect(dbSession.work_mode_testing_pct).not.toBeNull();
    expect(dbSession.work_mode_other_pct).not.toBeNull();

    const sum =
      dbSession.work_mode_exploration_pct! +
      dbSession.work_mode_building_pct! +
      dbSession.work_mode_testing_pct! +
      dbSession.work_mode_other_pct!;
    // Percentages should sum to ~100 (allow rounding ±2)
    expect(sum).toBeGreaterThanOrEqual(98);
    expect(sum).toBeLessThanOrEqual(102);

    // File-parse path: compute workMode from parseSessionTurns + classifyTurn + aggregateWorkMode
    const fpTurns = await parseSessionTurns(sessionFile, "C--dev-myapp");
    const fpWorkMode = aggregateWorkMode(
      fpTurns.filter((t) => t.role === "assistant").map((t) => ({ category: classifyTurn(t) }))
    );

    // Exact match across all 4 buckets — both paths use the same aggregateWorkMode
    // and classifyTurn, so values must be identical, not just sign-equal.
    expect(fpWorkMode.exploration).toBe(dbSession.work_mode_exploration_pct);
    expect(fpWorkMode.building).toBe(dbSession.work_mode_building_pct);
    expect(fpWorkMode.testing).toBe(dbSession.work_mode_testing_pct);
    expect(fpWorkMode.other).toBe(dbSession.work_mode_other_pct);
  });
});
