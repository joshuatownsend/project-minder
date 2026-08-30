import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * #487 — the boundary that keeps a delegated agent's turns out of everything
 * except its own timeline.
 *
 * The fix routes a `<parent>/subagents/*.jsonl` transcript through the writer
 * that produces real turns, because the sidechain collector produced only
 * assistant rows with no prose and the detail page rendered nothing. The first
 * attempt also wrote those rows as `is_sidechain = 0`, and that silently moved
 * every aggregate keyed on the flag:
 *
 *  - `querySubagentTotals` defines `subagentCost`/`subagentTokens` as
 *    `is_sidechain = 1`, so delegated spend would have VANISHED from the
 *    subagent breakout.
 *  - The billed engagement report, one-shot rates and activity streaks are all
 *    `is_sidechain = 0` and would have ABSORBED it. Engagement is the sharp
 *    one: it reads unrecognized user prose as a human at a keyboard, and a
 *    delegated transcript's user turns are generated delegation prompts
 *    ("review this module"), so each would have opened an attended block and
 *    earned tail credit on a figure that becomes a client invoice.
 *
 * (Codex P1 ×2, PR #528.) The rows therefore keep `is_sidechain = 1`, and this
 * file is the regression guard on that: it asserts the consequences, not the
 * implementation, so it still fails if some later change routes these turns
 * back onto the primary side by another route.
 */

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({
  prefix: "pm-subagent-billing-",
  env: { MINDER_USE_DB: "1" },
});
let tmpHome: string;

async function reload() {
  await state.reload();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  const conn = await import("@/lib/db/connection");
  const mig = await import("@/lib/db/migrations");
  const ingest = await import("@/lib/db/ingest");
  return { conn, mig, ingest };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const userLine = (ts: string, text: string, isSidechain: boolean) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    isSidechain,
    message: { content: [{ type: "text", text }] },
  });

function assistantLine(
  ts: string,
  messageId: string,
  blocks: unknown[],
  isSidechain: boolean
) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    isSidechain,
    message: {
      id: messageId,
      model: "claude-sonnet-4-5",
      content: blocks,
      stop_reason: "tool_use",
      usage: USAGE,
    },
  });
}

const toolBlock = (id: string, name: string) => ({
  type: "tool_use",
  id,
  name,
  input: { q: name },
});

async function write(rel: string, lines: string[]) {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  const file = path.join(projectsDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join("\n") + "\n");
  return { file, projectsDir };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("delegated transcripts keep their provenance", () => {
  it("renders its own timeline while staying out of the billed hours", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    // A root session with NO human prose at all, so any hours the engagement
    // report produces can only have come from the delegated file.
    const { projectsDir } = await write(path.join("C--dev-myapp", "beef01.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // The delegated transcript: prose that looks exactly like a human ask, at
    // timestamps far enough apart to open and sustain an attended block.
    await write(path.join("C--dev-myapp", "beef01", "subagents", "agent-1.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "review this module and report what you find", true),
      assistantLine("2026-08-01T10:06:00Z", "s0", [{ type: "text", text: "reviewed it" }], true),
      userLine("2026-08-01T10:20:00Z", "now check the other one the same way", true),
      assistantLine("2026-08-01T10:21:00Z", "s1", [{ type: "text", text: "checked it" }], true),
    ]);

    const stats = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);

    // ── The premise, asserted before anything is concluded from it ──────────
    // The rows are there, they carry PROSE (which is what was missing before —
    // the collector wrote assistant rows with a null preview), and they carry
    // the flag. Without this the test would pass just as well if ingest had
    // stopped walking `subagents/` altogether.
    const rows = db
      .prepare(
        "SELECT is_sidechain, role, text_preview FROM turns WHERE session_id = 'agent-1' ORDER BY turn_index"
      )
      .all() as Array<{ is_sidechain: number; role: string; text_preview: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.is_sidechain === 1)).toBe(true);
    expect(rows.some((r) => r.role === "user")).toBe(true);
    expect(rows.some((r) => (r.text_preview ?? "").includes("review this module"))).toBe(true);

    // ── The timeline renders anyway ────────────────────────────────────────
    const { loadSessionDetailFromDb } = await import("@/lib/data/sessionDetailFromDb");
    const detail = await loadSessionDetailFromDb(db, "agent-1");
    expect(detail).not.toBeNull();
    expect(detail!.timeline.length).toBeGreaterThan(0);
    // Known text, not just a count: a timeline of the right length built from
    // the wrong rows would satisfy a length check.
    expect(JSON.stringify(detail!.timeline)).toContain("review this module");

    // ── And none of it is billable ─────────────────────────────────────────
    const { loadEngagementReportFromSql } = await import("@/lib/data/engagementFromDb");
    const { resolveEngagementConfig } = await import("@/lib/engagement/config");
    const report = loadEngagementReportFromSql(db, {
      period: "all",
      timeZone: "UTC",
      config: resolveEngagementConfig({}),
    });
    // Zero, not merely "small". There is no human in this fixture, so a
    // threshold would have passed against the bug at a low enough count.
    expect(report.totalHours).toBe(0);
    expect(report.byProject).toHaveLength(0);

    // ── And the session card reports no work of its own ────────────────────
    // `turn_count` is a primary-only summary field. It is also what keeps these
    // out of the sessions list, so a non-zero value here would put a blank
    // delegated card in front of the user as well as moving the usage totals.
    //
    // EVERY primary-only column, not a sample — the list in `writeSession` is
    // hand-maintained, so an omission is the failure mode and this is where it
    // should surface rather than in a dashboard.
    //
    // Honest about what this DOES and does not prove for the one-shot columns:
    // they are structurally zero today because `detectOneShotTasks` anchors on
    // a tool call and a delegated transcript's `usageTurn.toolCalls` is empty,
    // so removing their explicit zeroing does NOT fail this test. The
    // assertion below pins that premise, so if #511 populates those tool calls
    // the guard stops being vacuous and this test starts carrying it.
    const summary = db
      .prepare(
        `SELECT turn_count, user_turn_count, assistant_turn_count, tool_call_count,
                error_count, input_tokens, output_tokens, cache_create_tokens,
                cache_read_tokens, cost_usd, has_one_shot, verified_task_count,
                one_shot_task_count
           FROM sessions WHERE session_id = 'agent-1'`
      )
      .get() as Record<string, number>;
    for (const [column, value] of Object.entries(summary)) {
      expect(`${column}=${value}`).toBe(`${column}=0`);
    }

    // The premise the one-shot columns currently rest on: no tool rows on the
    // primary path for this session, so the detector has nothing to anchor on.
    // When #511 changes that, this assertion fails and the zeroing above stops
    // being defence in depth.
    const primaryTools = db
      .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'agent-1'")
      .get() as { n: number };
    expect(primaryTools.n).toBe(0);
  });

  it("renders the agent's TOOL events, not just its prose", async () => {
    // The timeline and the file-operations list are both built from tool rows,
    // and a delegated agent's calls live in `sidechain_tool_uses` rather than
    // `tool_uses`. Reading only the latter rendered a tool-heavy delegated
    // session as prose with no actions — and dropped a tool-only assistant turn
    // entirely — while the file-parse backend, reading the JSONL directly,
    // showed them. A backend divergence, not just a gap. (Codex P1, PR #528.)
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const { projectsDir } = await write(path.join("C--dev-myapp", "beef04.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    await write(path.join("C--dev-myapp", "beef04", "subagents", "tooly.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "find the flaky test", true),
      // A TOOL-ONLY assistant turn: no prose at all. This is the turn that
      // vanished completely, so a timeline that merely looked short would not
      // have caught it.
      assistantLine("2026-08-01T10:06:00Z", "t0", [
        { type: "tool_use", id: "t_1", name: "Read", input: { file_path: "/repo/flaky.test.ts" } },
      ], true),
      assistantLine("2026-08-01T10:07:00Z", "t1", [{ type: "text", text: "found it" }], true),
    ]);

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    // The premise: the row is in the sidechain table WITH ordering, which is
    // what schema v30 added. A row with a NULL turn_index cannot be placed and
    // is deliberately not rendered, so this is the thing under test.
    const stored = db
      .prepare(
        `SELECT tool_name, turn_index, arguments_json FROM sidechain_tool_uses
          WHERE session_id = 'tooly'`
      )
      .all() as Array<{ tool_name: string; turn_index: number | null; arguments_json: string | null }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].tool_name).toBe("Read");
    expect(stored[0].turn_index).not.toBeNull();
    expect(stored[0].arguments_json ?? "").toContain("flaky.test.ts");

    const { loadSessionDetailFromDb } = await import("@/lib/data/sessionDetailFromDb");
    const detail = await loadSessionDetailFromDb(db, "tooly");
    expect(detail).not.toBeNull();

    // The tool event reaches the timeline...
    expect(JSON.stringify(detail!.timeline)).toContain("Read");
    // ...and the file operation reaches the Files tab, which is the half a
    // timeline-only assertion would have missed.
    expect(JSON.stringify(detail!.fileOperations ?? [])).toContain("flaky.test.ts");

    // And none of it leaked into `tool_uses`, which is the boundary #511 owns.
    const primary = db
      .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'tooly'")
      .get() as { n: number };
    expect(primary.n).toBe(0);
  });

  it("keeps the agent's tool order across continuation lines", async () => {
    // `sequence_in_turn` cannot come from `buildToolUses` for these rows: it
    // derives that from `turn.toolUses.length`, which never grows for a
    // delegated transcript because the calls go to `sidechain_tool_uses`. Every
    // continuation line of the same message therefore restarted at 0, two calls
    // in one turn shared a sequence, and the detail loader orders by exactly
    // that column — so the agent's actions could render in some order other
    // than the transcript's. (Codex P2, PR #528.)
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const { projectsDir } = await write(path.join("C--dev-myapp", "beef05.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // ONE message id across three lines — the continuation shape. The names are
    // distinguishable so the assertion is about ORDER, not merely uniqueness.
    await write(path.join("C--dev-myapp", "beef05", "subagents", "seq.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "sweep", true),
      assistantLine("2026-08-01T10:06:00Z", "s0", [toolBlock("s_1", "Glob")], true),
      assistantLine("2026-08-01T10:06:00Z", "s0", [toolBlock("s_2", "Grep")], true),
      assistantLine("2026-08-01T10:06:00Z", "s0", [toolBlock("s_3", "Read")], true),
    ]);

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const rows = db
      .prepare(
        `SELECT tool_name, turn_index, sequence_in_turn FROM sidechain_tool_uses
          WHERE session_id = 'seq' ORDER BY turn_index, sequence_in_turn`
      )
      .all() as Array<{ tool_name: string; turn_index: number; sequence_in_turn: number }>;

    expect(rows).toHaveLength(3);
    // Distinct sequences within the turn...
    expect(new Set(rows.map((r) => `${r.turn_index}:${r.sequence_in_turn}`)).size).toBe(3);
    // ...and the transcript's order, which is what the reader will render.
    expect(rows.map((r) => r.tool_name)).toEqual(["Glob", "Grep", "Read"]);
  });

  it("does not let a delegated API error reclassify the agent's spend", async () => {
    // The SECOND independent path by which the primary writer changed
    // classification for these turns. `isApiErrorMessage` sets `isError` on the
    // usage turn, `classifyTurn` books that cost as Debugging, and the sidechain
    // collector left it unset so the same spend came out as Conversation.
    // `queryByCategory` deliberately includes sidechain cost, so this moved the
    // usage-by-category report as a side effect of a timeline fix — and
    // suppressing `prevUserText` (the first path) does not touch it.
    // (Codex P2, PR #528.)
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const { projectsDir } = await write(path.join("C--dev-myapp", "beef06.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // Two delegated transcripts identical but for the API-error flag.
    await write(path.join("C--dev-myapp", "beef06", "subagents", "plain.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "proceed", true),
      assistantLine("2026-08-01T10:06:00Z", "p0", [{ type: "text", text: "did it" }], true),
    ]);
    const erroredFile = path.join(
      "C--dev-myapp",
      "beef06",
      "subagents",
      "errored.jsonl"
    );
    const projects = path.join(tmpHome, ".claude", "projects");
    const full = path.join(projects, erroredFile);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(
      full,
      [
        userLine("2026-08-01T10:05:00Z", "proceed", true),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-01T10:06:00Z",
          isSidechain: true,
          isApiErrorMessage: true,
          message: {
            id: "e0",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "did it" }],
            stop_reason: "tool_use",
            usage: USAGE,
          },
        }),
      ].join("\n") + "\n"
    );

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const rows = db
      .prepare(
        `SELECT session_id, category, is_error FROM turns
          WHERE session_id IN ('plain','errored') AND role = 'assistant'
          ORDER BY session_id`
      )
      .all() as Array<{ session_id: string; category: string | null; is_error: number }>;

    expect(rows).toHaveLength(2);
    // Same category: an API error must not rebook a delegated agent's spend.
    expect(rows[0].category).toBe(rows[1].category);
    // ...while the STORED flag still records what happened. Withholding it from
    // the classifier is not the same as pretending the turn succeeded, and a
    // fix that zeroed the column would pass the assertion above for the wrong
    // reason.
    const errored = rows.find((r) => r.session_id === "errored")!;
    expect(errored.is_error).toBe(1);
  });

  it("does not let a delegated prompt reclassify the agent's spend", async () => {
    // The prose is STORED (the timeline needs it) but must not become
    // `userIntentText` on the following assistant turn, which is what
    // `classifyTurn` reads. A generated delegation prompt carrying an intent
    // word — "debug this error", "plan the architecture" — would otherwise move
    // that agent's cost into Debugging or Planning, and `queryByCategory`
    // deliberately includes sidechain cost, so the usage-by-category report
    // would shift as a side effect of a timeline fix. The file backend never
    // propagates sidechain prompts as intent, so the two would also disagree.
    // (Codex P2, PR #528.)
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const { projectsDir } = await write(path.join("C--dev-myapp", "beef03.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // Two transcripts differing ONLY in the prompt's wording — one neutral, one
    // loaded with an intent keyword. If the prompt reaches the classifier they
    // land in different categories; if it does not, they agree.
    await write(path.join("C--dev-myapp", "beef03", "subagents", "neutral.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "proceed", true),
      assistantLine("2026-08-01T10:06:00Z", "n0", [{ type: "text", text: "did it" }], true),
    ]);
    await write(path.join("C--dev-myapp", "beef03", "subagents", "loaded.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "debug this error and fix the failing test", true),
      assistantLine("2026-08-01T10:06:00Z", "l0", [{ type: "text", text: "did it" }], true),
    ]);

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const rows = db
      .prepare(
        `SELECT session_id, category FROM turns
          WHERE session_id IN ('neutral','loaded') AND role = 'assistant'
          ORDER BY session_id`
      )
      .all() as Array<{ session_id: string; category: string | null }>;

    expect(rows).toHaveLength(2);
    // Equal to each other — the wording of a machine-written prompt must not be
    // what decides where an agent's spend is booked.
    expect(rows[0].category).toBe(rows[1].category);
  });

  it("counts a delegated agent's tool calls the same however the lines split", async () => {
    // `tool_call_count` must describe what the file did, not how its producer
    // chose to chunk it. Two transcripts with the SAME two calls — one message
    // carrying both blocks, versus a continuation line carrying the second —
    // must agree. An earlier revision skipped the block before the dedupe, so
    // the split file counted 1 and the whole file counted 2 (Copilot, PR #528).
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    const { projectsDir } = await write(path.join("C--dev-myapp", "beef02.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // Both blocks on one line.
    await write(path.join("C--dev-myapp", "beef02", "subagents", "whole.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "scan", true),
      assistantLine(
        "2026-08-01T10:06:00Z",
        "w0",
        [toolBlock("w_1", "WebSearch"), toolBlock("w_2", "WebSearch")],
        true
      ),
    ]);

    // Same two calls, the second arriving on a continuation of the same message.
    await write(path.join("C--dev-myapp", "beef02", "subagents", "split.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "scan", true),
      assistantLine("2026-08-01T10:06:00Z", "p0", [toolBlock("p_1", "WebSearch")], true),
      assistantLine("2026-08-01T10:06:00Z", "p0", [toolBlock("p_2", "WebSearch")], true),
    ]);

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    // Read from `sidechain_tool_uses`, which is where a delegated agent's calls
    // live — `sessions.tool_call_count` is a primary-only summary field and is
    // zero for these, by the same rule as `turn_count`.
    const counts = db
      .prepare(
        `SELECT session_id, COUNT(*) AS n FROM sidechain_tool_uses
          WHERE session_id IN ('whole','split') GROUP BY session_id ORDER BY session_id`
      )
      .all() as Array<{ session_id: string; n: number }>;

    expect(counts).toHaveLength(2);
    // Absolute, not just equal to each other: two counts agreeing at zero would
    // satisfy a parity check while proving nothing.
    expect(counts.map((c) => c.n)).toEqual([2, 2]);

    // And they stayed out of `tool_uses` — the #511 boundary this change is
    // careful not to cross.
    const primary = db
      .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id IN ('whole','split')")
      .get() as { n: number };
    expect(primary.n).toBe(0);
  });
});
