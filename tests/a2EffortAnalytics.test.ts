/**
 * A2 — effort analytics.
 *
 * The load-bearing test here is dual-backend parity. `byEffort` is assembled
 * two completely independent ways:
 *
 *   - file-parse: `detectOneShotTasks` walks the turn array live and buckets
 *     each task by its anchor turn's `effort`;
 *   - SQLite: ingest ran the SAME walk once and froze each verdict into
 *     `turns.task_outcome`, which a GROUP BY then crosses with `turns.effort`.
 *
 * Nothing but a test forces those to agree. A typecheck cannot see it, and the
 * failure mode is silent — two plausible numbers on the same dashboard
 * depending on `MINDER_USE_DB`.
 *
 * The second theme is that `unknown` is a real bucket. Most of this corpus
 * predates `effort`, so folding it into `medium` or dropping it would change
 * every rate on the page while still looking reasonable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { UNKNOWN_EFFORT, compareEffort, effortBucket, computeEffortMix } from "@/lib/usage/effort";
import { detectOneShot, detectOneShotTasks } from "@/lib/usage/oneShotDetector";
import type { UsageTurn, EffortBreakdown } from "@/lib/usage/types";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

// ── effort vocabulary ──────────────────────────────────────────────────────

describe("effort bucketing", () => {
  it("collapses absent / null / empty to the unknown bucket", () => {
    expect(effortBucket(undefined)).toBe(UNKNOWN_EFFORT);
    expect(effortBucket(null)).toBe(UNKNOWN_EFFORT);
    expect(effortBucket("")).toBe(UNKNOWN_EFFORT);
  });

  it("passes an unrecognized level through instead of swallowing it", () => {
    // A future Claude Code effort level must appear as its own bucket. Mapping
    // it to `unknown` would silently merge real, labelled spend into the
    // "we don't know" pile and there would be no signal that it happened.
    expect(effortBucket("ultra")).toBe("ultra");
  });

  it("orders by the ordinal scale, not alphabetically, with unknown last", () => {
    const sorted = ["unknown", "xhigh", "high", "low", "medium"].sort(compareEffort);
    expect(sorted).toEqual(["low", "medium", "high", "xhigh", "unknown"]);
  });

  it("sorts unrecognized levels after unknown, stably", () => {
    const sorted = ["ultra", "high", "unknown", "abyssal"].sort(compareEffort);
    expect(sorted).toEqual(["high", "unknown", "abyssal", "ultra"]);
  });
});

describe("computeEffortMix", () => {
  const t = (role: "user" | "assistant", effort?: string) =>
    ({ role, effort }) as Pick<UsageTurn, "role" | "effort">;

  it("counts only assistant turns that carry an effort", () => {
    expect(
      computeEffortMix([
        t("assistant", "high"),
        t("assistant", "high"),
        t("assistant", "xhigh"),
        t("assistant"), // pre-2.1.212 turn
        t("user", "high"), // user turns never carry one
      ])
    ).toEqual({ high: 2, xhigh: 1 });
  });

  it("returns undefined — not {} — when no turn carried an effort", () => {
    // `{}` would let a UI render "0 high-effort turns" for a session that
    // could not have reported any. Absence has to stay distinguishable from
    // a measured zero.
    expect(computeEffortMix([t("assistant"), t("user")])).toBeUndefined();
  });
});

// ── task anchoring ─────────────────────────────────────────────────────────

/** Minimal UsageTurn; only the fields the detector reads are meaningful. */
function turn(
  role: "user" | "assistant",
  opts: {
    tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
    toolResultText?: string;
    effort?: string;
  } = {}
): UsageTurn {
  return {
    timestamp: "2026-08-01T10:00:00Z",
    sessionId: "s1",
    projectSlug: "dev-x",
    projectDirName: "C--dev-x",
    model: "claude-opus-5",
    role,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: (opts.tools ?? []).map((t) => ({ name: t.name, arguments: t.arguments })),
    toolResultText: opts.toolResultText,
    effort: opts.effort,
  };
}

const edit = (effort?: string) => turn("assistant", { tools: [{ name: "Edit" }], effort });
const verify = (effort?: string) =>
  turn("assistant", { tools: [{ name: "Bash", arguments: { command: "pnpm test" } }], effort });
const result = (text: string) => turn("user", { toolResultText: text });

describe("detectOneShotTasks", () => {
  it("anchors each task on the EDIT turn, not the verification turn", () => {
    // The two carry different efforts on purpose: if the anchor slipped to the
    // verification turn, the cross-tab would credit `low` for work `xhigh`
    // actually did, and every number would still look plausible.
    const turns = [
      turn("user"),
      edit("xhigh"), // index 1 — the anchor
      verify("low"), // index 2
      result("All tests passed"),
      turn("assistant"),
    ];
    const tasks = detectOneShotTasks(turns);
    expect(tasks).toEqual([{ anchorIndex: 1, oneShot: true }]);
    expect(turns[tasks[0].anchorIndex].effort).toBe("xhigh");
  });

  it("marks a task whose verification failed as a retry, anchored on the edit", () => {
    const turns = [turn("user"), edit("high"), verify("high"), result("FAIL: 3 tests failed")];
    expect(detectOneShotTasks(turns)).toEqual([{ anchorIndex: 1, oneShot: false }]);
  });

  it("marks a task as a retry when a re-edit follows a passing verification", () => {
    const turns = [
      turn("user"),
      edit("high"),
      verify("high"),
      result("All tests passed"),
      edit("high"), // re-edit ⇒ the first pass wasn't the finished article
    ];
    const tasks = detectOneShotTasks(turns);
    expect(tasks[0]).toEqual({ anchorIndex: 1, oneShot: false });
  });

  it("reports no task for an edit that was never verified", () => {
    // NULL task_outcome means "started no verified task" — this is the case
    // that makes it the majority value, and it must not read as a failure.
    expect(detectOneShotTasks([turn("user"), edit("high"), turn("assistant")])).toEqual([]);
  });

  it("agrees exactly with detectOneShot's totals", () => {
    // detectOneShot is now a fold over this function. If they ever diverge,
    // the headline rate and the per-effort rates describe different worlds.
    const turns = [
      turn("user"),
      edit("high"),
      verify("high"),
      result("All tests passed"),
      turn("assistant"),
      edit("medium"),
      verify("medium"),
      result("FAIL: boom"),
    ];
    const tasks = detectOneShotTasks(turns);
    const stats = detectOneShot(turns);
    expect(stats.totalVerifiedTasks).toBe(tasks.length);
    expect(stats.oneShotTasks).toBe(tasks.filter((t) => t.oneShot).length);
    expect(stats).toEqual({ totalVerifiedTasks: 2, oneShotTasks: 1, rate: 0.5 });
  });
});

// ── dual-backend parity ────────────────────────────────────────────────────

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalUseDb: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalUseDb = process.env.MINDER_USE_DB;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-a2-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of [
    ["HOME", originalHome],
    ["USERPROFILE", originalUserProfile],
    ["MINDER_USE_DB", originalUseDb],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface Entry {
  type: string;
  timestamp: string;
  effort?: string;
  message?: unknown;
}

function jsonlAssistant(
  ts: string,
  effort: string | undefined,
  content: unknown[]
): Entry {
  const e: Entry = {
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
  // Top-level on the entry, NOT inside `message` — see A1.
  // `!== undefined`, not truthiness: `""` must reach the fixture as a real
  // empty-string field so the empty-effort normalization test has something
  // to normalize. Truthiness here would omit it and the test would pass
  // against a legacy-shaped turn instead.
  if (effort !== undefined) e.effort = effort;
  return e;
}

/**
 * A session containing three verified tasks at three different efforts, with
 * three different outcomes:
 *
 *   xhigh   → verification passed, nothing re-edited      ⇒ one_shot
 *   medium  → verification failed                          ⇒ retry
 *   (none)  → verification passed                          ⇒ one_shot, unknown
 *
 * The last one is the point: a turn written before `effort` existed still
 * anchors a real task, and its outcome belongs in the `unknown` bucket rather
 * than being dropped or folded into a level it never had.
 */
function fixtureEntries(): Entry[] {
  const bash = (id: string) => ({
    type: "tool_use",
    id,
    name: "Bash",
    input: { command: "pnpm test" },
  });
  const editTool = (id: string) => ({
    type: "tool_use",
    id,
    name: "Edit",
    input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
  });
  const toolResult = (ts: string, id: string, text: string) => ({
    type: "user",
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });

  return [
    { type: "user", timestamp: "2026-08-01T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix the parser" }] } },
    jsonlAssistant("2026-08-01T10:00:01Z", "xhigh", [editTool("tu_e1")]),
    toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
    jsonlAssistant("2026-08-01T10:00:03Z", "xhigh", [bash("tu_b1")]),
    toolResult("2026-08-01T10:00:04Z", "tu_b1", "Test Files 3 passed\nTests 12 passed"),
    jsonlAssistant("2026-08-01T10:00:05Z", "xhigh", [{ type: "text", text: "done" }]),

    jsonlAssistant("2026-08-01T10:00:06Z", "medium", [editTool("tu_e2")]),
    toolResult("2026-08-01T10:00:07Z", "tu_e2", "edited"),
    jsonlAssistant("2026-08-01T10:00:08Z", "medium", [bash("tu_b2")]),
    toolResult("2026-08-01T10:00:09Z", "tu_b2", "FAIL src/x.test.ts\nError: boom"),

    // No `effort` — a pre-2.1.212 turn, still a real verified task.
    jsonlAssistant("2026-08-01T10:00:10Z", undefined, [editTool("tu_e3")]),
    toolResult("2026-08-01T10:00:11Z", "tu_e3", "edited"),
    jsonlAssistant("2026-08-01T10:00:12Z", undefined, [bash("tu_b3")]),
    toolResult("2026-08-01T10:00:13Z", "tu_b3", "Test Files 3 passed"),
    jsonlAssistant("2026-08-01T10:00:14Z", undefined, [{ type: "text", text: "done" }]),
  ];
}

async function writeFixture(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "a2-session.jsonl"),
    fixtureEntries().map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

/** Index → `byEffort` keyed by bucket, so assertions read by name. */
function byKey(rows: EffortBreakdown[]): Record<string, EffortBreakdown> {
  return Object.fromEntries(rows.map((r) => [r.effort, r]));
}

describe.skipIf(!driverAvailable)("task_outcome across a tail-append", () => {
  const SESSION = path.join("C--dev-x", "tail-session.jsonl");

  async function writeEntries(entries: unknown[]): Promise<void> {
    const file = path.join(tmpHome, ".claude", "projects", SESSION);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** Ingest whatever is on disk, then read back every stamped outcome. */
  async function ingestAndRead(): Promise<Array<{ turn_index: number; effort: string | null; task_outcome: string | null }>> {
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = (await conn.getDb())!;
    const ingest = await import("@/lib/db/ingest");
    await ingest.reconcileAllSessions(db, {
      projectsDir: path.join(tmpHome, ".claude", "projects"),
    });
    return db
      .prepare(
        `SELECT turn_index, effort, task_outcome FROM turns
         WHERE role = 'assistant' ORDER BY turn_index`
      )
      .all() as Array<{ turn_index: number; effort: string | null; task_outcome: string | null }>;
  }

  const editTool = (id: string) => ({
    type: "tool_use", id, name: "Edit",
    input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
  });
  const bashTool = (id: string) => ({
    type: "tool_use", id, name: "Bash", input: { command: "pnpm test" },
  });
  const toolResult = (ts: string, id: string, text: string) => ({
    type: "user", timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });
  const prompt = (ts: string) => ({
    type: "user", timestamp: ts,
    message: { role: "user", content: [{ type: "text", text: "fix it" }] },
  });

  it("stamps an outcome on a prior turn when its verification arrives in the tail", async () => {
    // The straddle case. The edit lands in bytes we have already persisted and
    // the verification that judges it arrives later. A tail that only looked
    // at its own window could not see the edit at all, so this turn would
    // never receive an outcome — the task would be invisible to the cross-tab
    // forever, not merely delayed.
    await writeEntries([
      prompt("2026-08-01T10:00:00Z"),
      jsonlAssistant("2026-08-01T10:00:01Z", "high", [editTool("tu_e1")]),
      toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
    ]);
    const before = await ingestAndRead();
    expect(before.find((r) => r.turn_index === 1)?.task_outcome).toBeNull();

    await writeEntries([
      prompt("2026-08-01T10:00:00Z"),
      jsonlAssistant("2026-08-01T10:00:01Z", "high", [editTool("tu_e1")]),
      toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
      // ── everything below is the appended tail ──
      jsonlAssistant("2026-08-01T10:00:03Z", "high", [bashTool("tu_b1")]),
      toolResult("2026-08-01T10:00:04Z", "tu_b1", "Test Files 3 passed"),
      jsonlAssistant("2026-08-01T10:00:05Z", "high", [{ type: "text", text: "done" }]),
    ]);
    const after = await ingestAndRead();
    expect(after.find((r) => r.turn_index === 1)?.task_outcome).toBe("one_shot");
  });

  it("corrects a stale verdict when the tail turns a one-shot into a retry", async () => {
    // Verdicts are not append-only. With no following assistant turn the first
    // pass reads as a one-shot; the moment the tail adds a re-edit, the same
    // task becomes a retry. Leaving the old value behind would inflate every
    // success rate that turn contributes to.
    await writeEntries([
      prompt("2026-08-01T10:00:00Z"),
      jsonlAssistant("2026-08-01T10:00:01Z", "xhigh", [editTool("tu_e1")]),
      toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
      jsonlAssistant("2026-08-01T10:00:03Z", "xhigh", [bashTool("tu_b1")]),
      toolResult("2026-08-01T10:00:04Z", "tu_b1", "Test Files 3 passed"),
    ]);
    expect((await ingestAndRead()).find((r) => r.turn_index === 1)?.task_outcome).toBe("one_shot");

    await writeEntries([
      prompt("2026-08-01T10:00:00Z"),
      jsonlAssistant("2026-08-01T10:00:01Z", "xhigh", [editTool("tu_e1")]),
      toolResult("2026-08-01T10:00:02Z", "tu_e1", "edited"),
      jsonlAssistant("2026-08-01T10:00:03Z", "xhigh", [bashTool("tu_b1")]),
      toolResult("2026-08-01T10:00:04Z", "tu_b1", "Test Files 3 passed"),
      // ── tail: the model went back and edited again ──
      jsonlAssistant("2026-08-01T10:00:05Z", "xhigh", [editTool("tu_e2")]),
      toolResult("2026-08-01T10:00:06Z", "tu_e2", "edited"),
    ]);
    expect((await ingestAndRead()).find((r) => r.turn_index === 1)?.task_outcome).toBe("retry");
  });
});

describe.skipIf(!driverAvailable)("byEffort — adapter (non-Claude) sessions", () => {
  // The Claude parity test above ingests raw JSONL and so never exercises
  // `buildAdapterParsedSession`, which is a separate constructor of
  // `ParsedTurn[]` for Codex/Gemini sessions. It derived session-level one-shot
  // counts but stamped no per-turn outcome, so an adapter session's Edit -> test
  // cycles were counted in the headline rate and invisible to `byEffort` — but
  // only on the SQL backend, since the file backend re-walks the turns live.
  // Exactly the silent per-backend disagreement this slice must not introduce.
  // (Codex review, PR #378.)
  it("stamps task outcomes so the effort cross-tab sees adapter tasks too", async () => {
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    process.env.MINDER_USE_DB = "1";

    const mig = await import("@/lib/db/migrations");
    expect((await mig.initDb()).error).toBeNull();
    const conn = await import("@/lib/db/connection");
    const db = (await conn.getDb())!;
    const ingest = await import("@/lib/db/ingest");

    const adapterFile = path.join(tmpHome, ".codex", "sessions", "rollout-a2.jsonl");
    await fs.mkdir(path.dirname(adapterFile), { recursive: true });
    await fs.writeFile(adapterFile, "x"); // content irrelevant — the parse is mocked

    const uTurn = (
      ts: string,
      role: "user" | "assistant",
      extra: Partial<UsageTurn> = {}
    ): UsageTurn => ({
      timestamp: ts, sessionId: "cx-a2", projectSlug: "codexproj",
      projectDirName: "codexproj", model: role === "assistant" ? "gpt-5" : "",
      role, inputTokens: 200, outputTokens: 100,
      cacheCreateTokens: 0, cacheReadTokens: 0, toolCalls: [], ...extra,
    });

    await ingest.reconcileAllSessions(db, {
      projectsDir: path.join(tmpHome, "no-claude-tree"),
      config: { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmpHome, enabledAdapters: ["claude", "codex"] },
      adapterSessions: [{ source: "codex", filePath: adapterFile, projectDirName: "codexproj" }],
      // A complete Edit -> verify -> passing-result -> no-re-edit cycle: one
      // task, one-shot. Adapters record no `effort`, so it lands in `unknown`
      // — which is precisely why the bucket has to be real rather than dropped.
      parseAdapterFile: async () => [
        uTurn("2026-05-01T10:00:00Z", "user", { userMessageText: "fix the parser" }),
        uTurn("2026-05-01T10:00:01Z", "assistant", { toolCalls: [{ name: "Edit" }] }),
        uTurn("2026-05-01T10:00:02Z", "assistant", {
          toolCalls: [{ name: "Bash", arguments: { command: "pnpm test" } }],
        }),
        uTurn("2026-05-01T10:00:03Z", "user", { toolResultText: "Test Files 3 passed" }),
        uTurn("2026-05-01T10:00:04Z", "assistant", { assistantText: "done" }),
      ],
    });

    const stamped = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE task_outcome IS NOT NULL")
      .all() as Array<{ n: number }>;
    expect(stamped[0].n, "adapter turns must carry a persisted task outcome").toBe(1);

    const data = await import("@/lib/data");
    const { report, meta } = await data.getUsage("all", undefined, "codex");
    expect(meta.backend).toBe("db");

    const unknown = report.byEffort.find((r) => r.effort === UNKNOWN_EFFORT);
    expect(unknown).toBeDefined();
    // The claim that actually broke: the task is visible to the cross-tab, not
    // merely to the session-level headline.
    expect(unknown!.verifiedTasks).toBe(1);
    expect(unknown!.oneShotTasks).toBe(1);
    expect(unknown!.oneShotRate).toBe(1);

    // And it agrees with the session-level total the headline uses, which is
    // the invariant the missing stamp silently violated.
    expect(report.oneShot.totalVerifiedTasks).toBe(unknown!.verifiedTasks);

    conn.closeDb();
  });
});

describe.skipIf(!driverAvailable)("byEffort — file-parse vs SQLite parity", () => {
  async function reportFrom(useDb: boolean): Promise<EffortBreakdown[]> {
    vi.resetModules();
    delete (globalThis as { __minderDb?: unknown }).__minderDb;
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    process.env.MINDER_USE_DB = useDb ? "1" : "0";

    if (useDb) {
      const mig = await import("@/lib/db/migrations");
      const init = await mig.initDb();
      expect(init.error).toBeNull();
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
    // Guards the whole parity claim: if the DB leg silently fell back to
    // file-parse, the two legs would trivially agree and prove nothing.
    expect(meta.backend).toBe(useDb ? "db" : "file");
    return report.byEffort;
  }

  it("produces identical effort buckets on both backends", async () => {
    await writeFixture();
    const fileRows = await reportFrom(false);
    const dbRows = await reportFrom(true);

    // Same buckets, same order — ordering is part of the contract because the
    // chart reads left-to-right as an ordinal scale.
    expect(dbRows.map((r) => r.effort)).toEqual(fileRows.map((r) => r.effort));

    for (const key of fileRows.map((r) => r.effort)) {
      const f = byKey(fileRows)[key];
      const d = byKey(dbRows)[key];
      expect({ key, ...pick(d) }).toEqual({ key, ...pick(f) });
    }

    function pick(r: EffortBreakdown) {
      return {
        turns: r.turns,
        tokens: r.tokens,
        verifiedTasks: r.verifiedTasks,
        oneShotTasks: r.oneShotTasks,
        oneShotRate: r.oneShotRate,
      };
    }
  });

  it("crosses each effort with the outcome of the task it anchored", async () => {
    await writeFixture();
    const rows = byKey(await reportFrom(true));

    // xhigh anchored one task and it passed first time.
    expect(rows.xhigh.verifiedTasks).toBe(1);
    expect(rows.xhigh.oneShotTasks).toBe(1);
    expect(rows.xhigh.oneShotRate).toBe(1);

    // medium anchored one task and it needed a retry.
    expect(rows.medium.verifiedTasks).toBe(1);
    expect(rows.medium.oneShotTasks).toBe(0);
    expect(rows.medium.oneShotRate).toBe(0);

    // The effort-less turns anchored a real task too — it is reported under
    // `unknown`, not dropped and not merged into medium.
    expect(rows[UNKNOWN_EFFORT].verifiedTasks).toBe(1);
    expect(rows[UNKNOWN_EFFORT].oneShotTasks).toBe(1);

    // Sanity: the buckets partition the assistant turns, so no turn is
    // double-counted or lost between them. 3 xhigh + 2 medium + 3 effort-less.
    const totalTurns = Object.values(rows).reduce((s, r) => s + r.turns, 0);
    expect(totalTurns).toBe(8);
    expect(rows.xhigh.turns).toBe(3);
    expect(rows.medium.turns).toBe(2);
    expect(rows[UNKNOWN_EFFORT].turns).toBe(3);
  });

  it("buckets an empty-string effort as unknown on both backends", async () => {
    // `effortBucket("")` maps empty to `unknown`, but SQL `COALESCE` only
    // catches NULL — so an `"effort": ""` turn would form its own empty-labelled
    // bucket under MINDER_USE_DB=1 while the file backend folded it into
    // `unknown`. Same class of silent per-backend divergence as the adapter gap,
    // in a value neither reader filters out (both assign `entry.effort`
    // verbatim). Found by Codex on PR #378.
    const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "empty-effort.jsonl"),
      [
        { type: "user", timestamp: "2026-08-01T08:00:00Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        jsonlAssistant("2026-08-01T08:00:01Z", "", [{ type: "text", text: "hello" }]),
        jsonlAssistant("2026-08-01T08:00:02Z", "high", [{ type: "text", text: "still here" }]),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );

    for (const useDb of [false, true]) {
      const rows = await reportFrom(useDb);
      const labels = rows.map((r) => r.effort);
      expect(labels, `backend useDb=${useDb}`).not.toContain("");
      expect(labels.sort()).toEqual([UNKNOWN_EFFORT, "high"].sort());
      expect(byKey(rows)[UNKNOWN_EFFORT].turns, `backend useDb=${useDb}`).toBe(1);
    }
  });

  it("leaves oneShotRate undefined for a bucket that anchored no task", async () => {
    // A `low` turn that never edits anything. 0 would rank it below a level
    // that genuinely failed every attempt — a real ordering bug in any chart
    // sorted by success rate.
    const dir = path.join(tmpHome, ".claude", "projects", "C--dev-x");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "chatty.jsonl"),
      [
        { type: "user", timestamp: "2026-08-01T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "what does this do?" }] } },
        jsonlAssistant("2026-08-01T09:00:01Z", "low", [{ type: "text", text: "it parses JSONL" }]),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );

    for (const useDb of [false, true]) {
      const rows = byKey(await reportFrom(useDb));
      expect(rows.low.turns).toBe(1);
      expect(rows.low.verifiedTasks).toBe(0);
      expect(rows.low, `backend useDb=${useDb}`).not.toHaveProperty("oneShotRate");
    }
  });
});
