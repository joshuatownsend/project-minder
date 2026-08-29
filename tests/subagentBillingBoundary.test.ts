import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

/**
 * PR #528 review — the two things #487's change reached that it should not.
 *
 * #487 makes a delegated agent's turns PRIMARY, because the file is that
 * agent's own conversation and the detail page needs them. Two consumers were
 * relying on those turns being invisible, and neither said so:
 *
 *  1. The **billed engagement report** treats unrecognized user prose as a
 *     human at a keyboard. A delegated transcript's user turns are generated
 *     delegation prompts, so each would open an attended block and earn tail
 *     credit — on a figure that becomes a client invoice. (Codex P1.)
 *
 *  2. `tool_call_count` was made to depend on **where the producer split
 *     lines**: the first line of a message counted its blocks while a
 *     continuation line's were dropped before the dedupe. (Copilot.)
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

/** A user turn with real prose — what the engagement classifier reads. */
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

describe.skipIf(!driverAvailable)("delegated transcripts and the billed hours", () => {
  it("does not bill a generated delegation prompt as human engagement", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const db = (await conn.getDb())!;

    // A root session with NO human prose at all, so any hours the report
    // produces can only have come from the delegated file. Its assistant turns
    // carry no user text to attend to.
    const { projectsDir } = await write(path.join("C--dev-myapp", "beef01.jsonl"), [
      assistantLine("2026-08-01T10:00:00Z", "m1", [{ type: "text", text: "ok" }], false),
    ]);

    // The delegated transcript: prose that looks exactly like a human ask, at
    // timestamps far enough apart to open and sustain an attended block.
    await write(path.join("C--dev-myapp", "beef01", "subagents", "agent-1.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "review this module and report what you find", true),
      assistantLine("2026-08-01T10:06:00Z", "s0", [{ type: "text", text: "reviewed" }], true),
      userLine("2026-08-01T10:20:00Z", "now check the other one the same way", true),
      assistantLine("2026-08-01T10:21:00Z", "s1", [{ type: "text", text: "done" }], true),
    ]);

    const stats = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);

    // The premise, asserted before anything is concluded from it: the delegated
    // rows really are indexed and really are primary now. Without this the test
    // would pass just as well if ingest had stopped walking `subagents/`.
    const nested = db
      .prepare(
        "SELECT COUNT(*) AS n FROM turns WHERE session_id = 'agent-1' AND is_sidechain = 0"
      )
      .get() as { n: number };
    expect(nested.n).toBeGreaterThan(0);

    const { loadEngagementReportFromSql } = await import("@/lib/data/engagementFromDb");
    const { resolveEngagementConfig } = await import("@/lib/engagement/config");
    const report = loadEngagementReportFromSql(db, {
      period: "all",
      timeZone: "UTC",
      config: resolveEngagementConfig({}),
    });

    // Zero, not merely "small". There is no human in this fixture.
    expect(report.totalHours).toBe(0);
    expect(report.byProject).toHaveLength(0);

    // And the drop is DISCLOSED rather than silent — a billing report that
    // quietly discards rows it declined to count is the provenance gap the
    // disclosure line exists to close.
    expect(report.excludedAutomatedSessions).toBeGreaterThan(0);
  });

  it("counts a delegated agent's tool calls the same however the lines split", async () => {
    // `tool_call_count` must describe what the file did, not how its producer
    // chose to chunk it. Two transcripts with the SAME two calls — one message
    // carrying both blocks, versus a continuation line carrying the second —
    // must agree. Before the fix the continuation block was dropped before the
    // dedupe, so the split file counted 1 and the whole file counted 2.
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

    // Same two calls, second one arriving on a continuation of the same message.
    await write(path.join("C--dev-myapp", "beef02", "subagents", "split.jsonl"), [
      userLine("2026-08-01T10:05:00Z", "scan", true),
      assistantLine("2026-08-01T10:06:00Z", "p0", [toolBlock("p_1", "WebSearch")], true),
      assistantLine("2026-08-01T10:06:00Z", "p0", [toolBlock("p_2", "WebSearch")], true),
    ]);

    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const counts = db
      .prepare(
        "SELECT session_id, tool_call_count FROM sessions WHERE session_id IN ('whole','split') ORDER BY session_id"
      )
      .all() as Array<{ session_id: string; tool_call_count: number }>;

    expect(counts).toHaveLength(2);
    // Absolute, not just equal to each other: two counts that agreed at zero
    // would satisfy a parity check while proving nothing.
    expect(counts.map((c) => c.tool_call_count)).toEqual([2, 2]);

    // And the rows still stayed out of `tool_uses` — the #511 boundary this PR
    // is careful not to cross.
    const primary = db
      .prepare("SELECT COUNT(*) AS n FROM tool_uses WHERE session_id IN ('whole','split')")
      .get() as { n: number };
    expect(primary.n).toBe(0);
  });
});
