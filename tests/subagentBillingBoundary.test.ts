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
    const summary = db
      .prepare(
        "SELECT turn_count, input_tokens, cost_usd FROM sessions WHERE session_id = 'agent-1'"
      )
      .get() as { turn_count: number; input_tokens: number; cost_usd: number };
    expect(summary.turn_count).toBe(0);
    expect(summary.input_tokens).toBe(0);
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
