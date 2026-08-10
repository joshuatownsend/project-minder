/**
 * A5 — `byCategory.oneShotRate`.
 *
 * Two claims, and the first is a regression guard against a defect that shipped
 * silently for a long time.
 *
 * **Anchoring.** A task is attributed to the category of the turn that *started*
 * it. The previous implementation instead sliced each category's turns out of
 * the session and re-ran the detector over the slice — which cannot work,
 * because the classifier puts the edit in `Coding` and the `pnpm test` that
 * judges it in `Testing`. Every ordinary task was split across two slices,
 * leaving an edit with no verification in one and a verification with no edit
 * in the other, so neither half formed a task. The observable symptom: the
 * headline reported the task, and every category reported no rate at all.
 *
 * **Dual-backend parity.** The rate is assembled two independent ways — the
 * file backend walks the turns live, the SQL backend crosses `turns.category`
 * with the `turns.task_outcome` ingest froze. Nothing but a test forces those
 * to agree, and the failure mode is two plausible numbers on one dashboard
 * depending on `MINDER_USE_DB`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity } from "@/lib/usage/activityBuckets";
import { classifyTurn } from "@/lib/usage/classifier";
import type { UsageTurn, CategoryBreakdown } from "@/lib/usage/types";
import { installIsolatedState } from "../_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

// ── anchoring (file backend, no DB needed) ─────────────────────────────────

function turn(
  role: "user" | "assistant",
  opts: {
    tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
    toolResultText?: string;
    text?: string;
  } = {}
): UsageTurn {
  return {
    timestamp: "2026-08-01T10:00:00Z",
    sessionId: "s1",
    projectSlug: "dev-x",
    projectDirName: "C--dev-x",
    model: "claude-opus-5",
    role,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: (opts.tools ?? []).map((t) => ({ name: t.name, arguments: t.arguments })),
    toolResultText: opts.toolResultText,
    assistantText: opts.text,
  };
}

const editOf = (file: string) =>
  turn("assistant", { tools: [{ name: "Edit", arguments: { file_path: file } }] });
const runTests = () =>
  turn("assistant", { tools: [{ name: "Bash", arguments: { command: "pnpm test" } }] });

/** `byCategory` keyed by category, so assertions read by name. */
function byKey(rows: CategoryBreakdown[]): Record<string, CategoryBreakdown> {
  return Object.fromEntries(rows.map((r) => [r.category, r]));
}

describe("byCategory.oneShotRate — anchoring", () => {
  it("credits the category of the EDIT, not of the verification that judged it", async () => {
    // The exact shape the old slicing implementation could not see: the two
    // halves of one task classify into two different categories.
    const turns = [
      turn("user", { text: "fix the parser" }),
      editOf("/repo/a.ts"), // Coding — the anchor
      runTests(), // Testing — the verification
      turn("user", { toolResultText: "Test Files 3 passed" }),
      turn("assistant", { text: "done" }),
    ];
    // Stated as an assertion rather than a comment: if the classifier ever put
    // both turns in one category, this test would still pass while having
    // stopped exercising the split that caused the bug.
    expect(classifyTurn(turns[1])).toBe("Coding");
    expect(classifyTurn(turns[2])).toBe("Testing");

    const rows = byKey((await aggregateUsage(turns, "all", emptyActivity())).byCategory);
    expect(rows.Coding.oneShotRate).toBe(1);
    // Testing spent tokens but anchored nothing, so it reports no rate.
    expect(rows.Testing).not.toHaveProperty("oneShotRate");
  });

  it("agrees with the headline on how many tasks there were", async () => {
    // The invariant the defect violated: the headline counted a task the
    // per-category view could not find anywhere.
    const turns = [
      turn("user", { text: "fix it" }),
      editOf("/repo/a.ts"),
      runTests(),
      turn("user", { toolResultText: "Test Files 3 passed" }),
      turn("assistant", { text: "done" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.oneShot.totalVerifiedTasks).toBe(1);
    expect(report.byCategory.filter((c) => c.oneShotRate !== undefined)).toHaveLength(1);
  });

  it("separates two categories that each anchored a task with a different outcome", async () => {
    // An edit to a *test* file classifies as Testing and still anchors a task,
    // so both categories carry real, and different, rates. A single-category
    // fixture could not tell correct bucketing from "put everything in Coding".
    const turns = [
      turn("user", { text: "ship it" }),
      editOf("/repo/a.ts"), // Coding
      runTests(),
      turn("user", { toolResultText: "Test Files 3 passed" }),
      turn("assistant", { text: "src done" }),
      editOf("/repo/b.test.ts"), // Testing
      runTests(),
      turn("user", { toolResultText: "FAIL src/b.test.ts\nError: boom" }),
    ];
    expect(classifyTurn(turns[5])).toBe("Testing");

    const rows = byKey((await aggregateUsage(turns, "all", emptyActivity())).byCategory);
    expect(rows.Coding.oneShotRate).toBe(1);
    expect(rows.Testing.oneShotRate).toBe(0);
  });

  it("omits the rate entirely for a category that anchored no task", async () => {
    // `undefined`, never 0. Zero would rank a category nobody measured below
    // one that genuinely failed every attempt in any rate-sorted view.
    const turns = [
      turn("user", { text: "what does this do?" }),
      turn("assistant", { text: "it parses JSONL" }),
    ];
    const rows = (await aggregateUsage(turns, "all", emptyActivity())).byCategory;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toHaveProperty("oneShotRate");
  });
});

// ── dual-backend parity ────────────────────────────────────────────────────

const state = installIsolatedState({ prefix: "pm-a5-", preserveEnv: ["MINDER_USE_DB"] });

let tmpHome: string;
beforeEach(() => {
  tmpHome = state.tmpHome();
});

interface Entry {
  type: string;
  timestamp: string;
  message?: unknown;
}

function jsonlAssistant(ts: string, content: unknown[]): Entry {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-opus-5",
      role: "assistant",
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

/**
 * Two verified tasks anchored in two different categories with two different
 * outcomes:
 *
 *   Edit /repo/a.ts      → Coding,  verification passed  ⇒ one_shot
 *   Edit /repo/b.test.ts → Testing, verification failed  ⇒ retry
 *
 * Both halves of each task straddle a category boundary (the `pnpm test` that
 * judges the Coding edit is itself Testing), which is the case the old
 * implementation lost.
 */
function fixtureEntries(): Entry[] {
  const bash = (id: string) => ({
    type: "tool_use", id, name: "Bash", input: { command: "pnpm test" },
  });
  const editTool = (id: string, file: string) => ({
    type: "tool_use", id, name: "Edit",
    input: { file_path: file, old_string: "a", new_string: "b" },
  });
  const toolResult = (ts: string, id: string, text: string) => ({
    type: "user", timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });

  return [
    { type: "user", timestamp: "2026-08-01T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix the parser" }] } },
    jsonlAssistant("2026-08-01T10:00:01Z", [editTool("tu_e1", "/repo/a.ts")]),
    toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
    jsonlAssistant("2026-08-01T10:00:03Z", [bash("tu_b1")]),
    toolResult("2026-08-01T10:00:04Z", "tu_b1", "Test Files 3 passed\nTests 12 passed"),
    jsonlAssistant("2026-08-01T10:00:05Z", [{ type: "text", text: "done" }]),

    jsonlAssistant("2026-08-01T10:00:06Z", [editTool("tu_e2", "/repo/b.test.ts")]),
    toolResult("2026-08-01T10:00:07Z", "tu_e2", "edited"),
    jsonlAssistant("2026-08-01T10:00:08Z", [bash("tu_b2")]),
    toolResult("2026-08-01T10:00:09Z", "tu_b2", "FAIL src/b.test.ts\nError: boom"),
  ];
}

async function writeFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "a5-session.jsonl"),
    fixtureEntries().map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

describe.skipIf(!driverAvailable)("byCategory — file-parse vs SQLite parity", () => {
  async function reportFrom(useDb: boolean): Promise<CategoryBreakdown[]> {
    await state.reload();
    process.env.MINDER_USE_DB = useDb ? "1" : "0";

    if (useDb) {
      const mig = await import("@/lib/db/migrations");
      expect((await mig.initDb()).error).toBeNull();
      const conn = await import("@/lib/db/connection");
      const db = await conn.getDb();
      expect(db).not.toBeNull();
      const ingest = await import("@/lib/db/ingest");
      await ingest.reconcileAllSessions(db!, {
        projectsDir: path.join(tmpHome, ".claude", "projects"),
      });
    }
    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined);
    // Guards the whole parity claim: a DB leg that silently fell back to
    // file-parse would agree trivially and prove nothing.
    expect(meta.backend).toBe(useDb ? "db" : "file");
    return report.byCategory;
  }

  it("produces the same per-category rates on both backends", async () => {
    await writeFixture();
    const fileRows = byKey(await reportFrom(false));
    const dbRows = byKey(await reportFrom(true));

    expect(Object.keys(dbRows).sort()).toEqual(Object.keys(fileRows).sort());
    for (const key of Object.keys(fileRows)) {
      expect(
        { key, rate: dbRows[key].oneShotRate },
        `category ${key}`
      ).toEqual({ key, rate: fileRows[key].oneShotRate });
    }
  });

  it("crosses each category with the outcome of the task it anchored", async () => {
    await writeFixture();
    for (const useDb of [false, true]) {
      const rows = byKey(await reportFrom(useDb));
      expect(rows.Coding.oneShotRate, `backend useDb=${useDb}`).toBe(1);
      expect(rows.Testing.oneShotRate, `backend useDb=${useDb}`).toBe(0);
    }
  });

  it("reports the rate on the source-filtered path too", async () => {
    // `queryByCategory` has two SQL bodies: the fast `category_costs` rollup,
    // and a live recompute over `turns` used whenever a `?source=` or `?home=`
    // filter is present (the rollup carries neither column). Only the rollup
    // path is exercised above, so without this the filtered body could drop
    // the rate entirely and every other test here would still pass.
    await writeFixture();
    await state.reload();
    process.env.MINDER_USE_DB = "1";

    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = await conn.getDb();
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db!, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined, "claude");
    expect(meta.backend).toBe("db");

    const rows = byKey(report.byCategory);
    expect(rows.Coding.oneShotRate).toBe(1);
    expect(rows.Testing.oneShotRate).toBe(0);
  });

  it("ignores a task outcome stamped on a subagent turn", async () => {
    // `schema.sql` states the contract: one-shot reads guard on
    // `is_sidechain = 0`. Ingest never anchors an outcome on a sidechain turn
    // today, so this state is unreachable through the normal path — which is
    // exactly why it is worth pinning. Without the guard the read depends on an
    // invariant enforced in a different module, and a future ingest regression
    // would corrupt these counts with nothing failing. (Copilot, PR #424.)
    //
    // The subagent row is a copy of a real turn so it satisfies every NOT NULL
    // column, with only the three fields under test changed. It is stamped
    // `retry` against `Coding`, whose genuine task passed: an unguarded read
    // would halve that category's rate from 1 to 0.5, which no rounding or
    // ordering difference could produce.
    await writeFixture();
    await state.reload();
    process.env.MINDER_USE_DB = "1";

    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = (await conn.getDb())!;
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });

    const cols = (db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    const src = db
      .prepare("SELECT * FROM turns WHERE role = 'assistant' LIMIT 1")
      .get() as Record<string, unknown>;
    const maxIdx = (db.prepare("SELECT MAX(turn_index) AS m FROM turns").get() as { m: number }).m;
    db.prepare(
      `INSERT INTO turns (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`
    ).run({
      ...src,
      turn_index: maxIdx + 1,
      is_sidechain: 1,
      task_outcome: "retry",
      category: "Coding",
    });

    // Guard the guard: if the row did not land, the assertions below would
    // pass against an unchanged table and prove nothing.
    const planted = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE is_sidechain = 1 AND task_outcome IS NOT NULL")
      .get() as { n: number };
    expect(planted.n, "the sidechain row under test must exist").toBe(1);

    const data = await import("@/lib/data");
    // Both SQL bodies: the rollup path (no filter) and the live recompute.
    for (const source of [undefined, "claude"]) {
      const { report } = await data.getUsage("all", undefined, source);
      const rows = byKey(report.byCategory);
      expect(rows.Coding.oneShotRate, `source=${source ?? "none"}`).toBe(1);
    }

    conn.closeDb();
  });

  it("omits the rate on both backends for a category that anchored no task", async () => {
    const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chatty.jsonl"),
      [
        { type: "user", timestamp: "2026-08-01T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "what does this do?" }] } },
        jsonlAssistant("2026-08-01T09:00:01Z", [{ type: "text", text: "it parses JSONL" }]),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );

    for (const useDb of [false, true]) {
      const rows = await reportFrom(useDb);
      expect(rows.length, `backend useDb=${useDb}`).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r, `backend useDb=${useDb}, category ${r.category}`).not.toHaveProperty("oneShotRate");
      }
    }
  });
});
