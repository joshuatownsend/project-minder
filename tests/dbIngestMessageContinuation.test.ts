/**
 * #426 — one assistant message split across several JSONL lines.
 *
 * Claude Code writes **one line per content block**. A message that thought,
 * then called two tools is four lines sharing a `message.id`, each repeating
 * the message-level `usage` verbatim. Ingest used to `continue` on the repeat
 * id (the A6 re-log guard) and threw away whatever block the line carried.
 *
 * On the reference corpus that cost 1,996 of 2,716 `tool_use` blocks on a
 * single session — `Agent` 72 → 6 — and left 5,652 of 6,036 sessions with no
 * `tool_uses` rows at all. It also silently truncated `text_preview` and the
 * FTS body, because a message whose first line is a `thinking` block stored no
 * text.
 *
 * **Why this file exists rather than another case in `dbIngest.test.ts`.** That
 * suite's `assistantTurn` helper packs every block into ONE entry, which is the
 * shape that cannot express this bug — three parity tests ran green across a
 * 12x divergence for exactly that reason. The fixtures here emit one entry per
 * block on purpose; a test that reuses the old helper cannot fail.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

// Pinned rather than preserved. These assertions read indexed rows, so the DB
// path is a requirement of the file, not an ambient preference — the same
// reason `initDb.test.ts` and `agentCost.test.ts` pin it. (Reviewer predicted
// a failure under `MINDER_USE_DB=0`, which does not actually occur: this file
// calls `initDb`/`getDb`/`reconcileAllSessions` directly and never goes
// through the `data/index.ts` façade that reads the flag. Pinned anyway, so
// the requirement is stated rather than inferred.)
const state = installIsolatedState({
  prefix: "pm-ingest-cont-",
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
  input_tokens: 200,
  output_tokens: 90,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * One JSONL line carrying ONE content block of a shared message.
 *
 * `usage` is repeated on every line exactly as Claude Code repeats it — 3,248
 * identical / 0 differing on the measured corpus. That repetition is what makes
 * "dedupe tokens, union blocks" the only correct reading: summing usage per
 * line would multiply a message's cost by its block count.
 */
function line(timestamp: string, messageId: string, block: unknown) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      id: messageId,
      model: "claude-sonnet-4-5",
      content: [block],
      stop_reason: "tool_use",
      usage: USAGE,
    },
  });
}

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });
const toolBlock = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});

async function writeFixture(projectsDir: string, sessionId: string): Promise<void> {
  const file = path.join(projectsDir, "C--dev-myapp", `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-01T10:00:00Z",
      message: { content: [{ type: "text", text: "audit the parser" }] },
    }),
    // One message, six lines. Thinking first, so first-block-only storage
    // leaves the turn with no prose at all — the text half of the bug.
    line("2026-08-01T10:00:01Z", "msg_1", thinkingBlock("weighing two approaches")),
    line("2026-08-01T10:00:01Z", "msg_1", thinkingBlock("second thought, deeper")),
    line("2026-08-01T10:00:01Z", "msg_1", textBlock("Delegating the sweep.")),
    // The same prose block re-logged. Tools dedupe on `tool_use_id`; text has
    // no id, so it dedupes on the body — without that, the merge would append
    // this to the turn and the preview would read the sentence twice.
    line("2026-08-01T10:00:01Z", "msg_1", textBlock("Delegating the sweep.")),
    line("2026-08-01T10:00:01Z", "msg_1", toolBlock("tu_a", "Agent", { description: "scan A" })),
    line("2026-08-01T10:00:01Z", "msg_1", toolBlock("tu_b", "Agent", { description: "scan B" })),
    // A GENUINE re-log: same message, same tool_use_id, emitted twice. This is
    // the case the A6 guard was written for and the union must still drop it.
    line("2026-08-01T10:00:01Z", "msg_1", toolBlock("tu_b", "Agent", { description: "scan B" })),
    // A separate, ordinary single-line message, to prove the merge does not
    // swallow the message that follows it.
    line("2026-08-01T10:00:02Z", "msg_2", textBlock("Done.")),
  ];
  await fs.writeFile(file, lines.join("\n") + "\n");
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("#426 multi-line assistant messages", () => {
  async function ingestFixture(sessionId: string) {
    const { conn, mig, ingest } = await reload();
    const init = await mig.initDb();
    expect(init.error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeFixture(projectsDir, sessionId);
    const db = (await conn.getDb())!;
    const stats = await ingest.reconcileAllSessions(db, { projectsDir });
    expect(stats.errors).toBe(0);
    return db;
  }

  it("stores every tool call, not only the one on the first line", async () => {
    const db = await ingestFixture("cafe01");
    const tools = db
      .prepare(
        "SELECT tool_name, tool_use_id, sequence_in_turn FROM tool_uses WHERE session_id = 'cafe01' ORDER BY sequence_in_turn"
      )
      .all() as Array<{ tool_name: string; tool_use_id: string; sequence_in_turn: number }>;
    // Two distinct spawns survive; the re-logged third is dropped by
    // tool_use_id. Before the fix this was zero rows — the tool blocks all sat
    // on continuation lines.
    expect(tools.map((t) => t.tool_use_id)).toEqual(["tu_a", "tu_b"]);
    expect(tools.every((t) => t.tool_name === "Agent")).toBe(true);
    // sequence_in_turn stays dense from 0 across the merge rather than
    // restarting per line, which would collide on the turn's primary key.
    expect(tools.map((t) => t.sequence_in_turn)).toEqual([0, 1]);
  });

  it("counts the message as one turn and its tokens once", async () => {
    const db = await ingestFixture("cafe02");
    const session = db
      .prepare("SELECT * FROM sessions WHERE session_id = 'cafe02'")
      .get() as any;
    // Six lines of msg_1 + one of msg_2 = two assistant turns, not seven.
    expect(session.assistant_turn_count).toBe(2);
    expect(session.user_turn_count).toBe(1);
    // The load-bearing assertion for the merge: usage repeats on every line,
    // so a per-line sum would report 6x this for msg_1 alone.
    expect(session.input_tokens).toBe(USAGE.input_tokens * 2);
    expect(session.output_tokens).toBe(USAGE.output_tokens * 2);
    expect(session.tool_call_count).toBe(2);

    const turns = db
      .prepare("SELECT role FROM turns WHERE session_id = 'cafe02' ORDER BY turn_index")
      .all() as Array<{ role: string }>;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("keeps prose that arrived after the first block, and indexes the thinking", async () => {
    const db = await ingestFixture("cafe03");
    const turn = db
      .prepare(
        "SELECT text_preview, has_thinking FROM turns WHERE session_id = 'cafe03' AND role = 'assistant' ORDER BY turn_index"
      )
      .get() as { text_preview: string | null; has_thinking: number };
    // The message's first line was a thinking block, so before the fix this
    // turn stored no prose whatsoever. Exact equality is the point: the same
    // block is re-logged in the fixture, and a merge that appended it would
    // give "Delegating the sweep.\nDelegating the sweep.".
    expect(turn.text_preview).toBe("Delegating the sweep.");
    expect(turn.has_thinking).toBe(1);

    // Both thinking blocks reach the FTS body — the second one arrived on a
    // continuation line and used to be dropped with it.
    const hit = db
      .prepare(
        "SELECT COUNT(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'deeper' AND session_id = 'cafe03'"
      )
      .get() as { n: number };
    expect(hit.n).toBeGreaterThan(0);
  });

  it("agrees with the file backend on the spawn count", async () => {
    // The divergence this closes was 12x on a real session (file 72, DB 6) and
    // no parity test saw it. Asserting both backends here rather than trusting
    // the DB number alone.
    const db = await ingestFixture("cafe04");
    const dbSpawns = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tool_uses WHERE session_id = 'cafe04' AND tool_name = 'Agent'"
        )
        .get() as { n: number }
    ).n;

    const { scanSessionDetail } = await import("@/lib/scanner/claudeConversations");
    const detail = await scanSessionDetail("cafe04");
    expect(detail).not.toBeNull();
    // The file backend has no message-id dedupe, so it counts the re-logged
    // block too: 3 against the DB's 2. Documented divergence, direction stated
    // — it OVER-counts by the re-log rate (22 blocks in 5,591 on the measured
    // corpus, ~0.4%), where before this fix the DB UNDER-counted by 92%.
    expect(detail!.toolUsage["Agent"]).toBe(3);
    expect(dbSpawns).toBe(2);
    expect(Math.abs(detail!.toolUsage["Agent"]! - dbSpawns)).toBeLessThanOrEqual(1);
  });

  /**
   * A continuation that arrives after later turns must not revive its own
   * turn's pending tool calls.
   *
   * Continuations are usually adjacent, but not reliably: across four large
   * transcripts 6 to 87 per session were separated from their first line, one
   * by 3,639 lines. `lastAssistantPendingIds` describes the CURRENT last
   * assistant turn, so extending it from an older turn would leave a finished
   * session stuck reporting `waiting` — which the dashboard time-gates into
   * `needs_attention`, an alert for work that already completed.
   */
  it("does not reopen a finished session when a continuation arrives late", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "cafe05.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:00Z",
          message: { content: [{ type: "text", text: "run the sweep" }] },
        }),
        line("2026-08-01T10:00:01Z", "msg_1", toolBlock("tu_1", "Bash", { command: "ls" })),
        // The tool answered, so msg_1 has nothing outstanding.
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:02Z",
          message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
        }),
        // A later message finishes the session cleanly.
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-01T10:00:03Z",
          message: {
            id: "msg_2",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "All done." }],
            stop_reason: "end_turn",
            usage: USAGE,
          },
        }),
        // …and only now does another block of msg_1 turn up.
        line("2026-08-01T10:00:04Z", "msg_1", toolBlock("tu_late", "Bash", { command: "pwd" })),
      ].join("\n") + "\n"
    );

    const db = (await conn.getDb())!;
    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const session = db
      .prepare("SELECT status FROM sessions WHERE session_id = 'cafe05'")
      .get() as { status: string | null };
    // The late block is still stored on msg_1's turn…
    const tools = db
      .prepare("SELECT tool_use_id FROM tool_uses WHERE session_id = 'cafe05' ORDER BY sequence_in_turn")
      .all() as Array<{ tool_use_id: string }>;
    expect(tools.map((t) => t.tool_use_id)).toEqual(["tu_1", "tu_late"]);
    // …but it does not become an unresolved call on a session that ended.
    expect(session.status).toBe("inactive");
  });

  /**
   * A block with no usable `name` reads the same in both representations.
   *
   * `tool_uses.tool_name` and `usageTurn.toolCalls[].name` describe the same
   * block, and `ToolCall.name` is typed `string`. The stored row fell back to
   * `"unknown"` while the in-memory view was built through an `any` cast that
   * let `undefined` past the type — and that view is what `classifyTurn`
   * matches on. Asserted on both the first line and a continuation, because
   * the merge path was a second construction site free to disagree.
   */
  it("normalizes a nameless tool block identically on both paths", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "cafe09.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // `name` omitted entirely — the malformed shape both sites must agree on.
    const nameless = (id: string) => ({ type: "tool_use", id, input: { a: 1 } });
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:00Z",
          message: { content: [{ type: "text", text: "go" }] },
        }),
        line("2026-08-01T10:00:01Z", "msg_1", nameless("tu_first")),
        line("2026-08-01T10:00:01Z", "msg_1", nameless("tu_cont")),
      ].join("\n") + "\n"
    );

    const db = (await conn.getDb())!;
    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const rows = db
      .prepare(
        "SELECT tool_use_id, tool_name FROM tool_uses WHERE session_id = 'cafe09' ORDER BY sequence_in_turn"
      )
      .all() as Array<{ tool_use_id: string; tool_name: string }>;
    // Both blocks stored, and the continuation is normalized like the first.
    expect(rows).toEqual([
      { tool_use_id: "tu_first", tool_name: "unknown" },
      { tool_use_id: "tu_cont", tool_name: "unknown" },
    ]);
  });

  /**
   * Slash-command attribution follows the message, not the cursor.
   *
   * `buildToolUses` used to read the live `prevUserTimestamp` every time it
   * ran. For a continuation arriving after an intervening user turn — the case
   * this merge exists to support — that names a different prompt, so a `Skill`
   * call split onto a later line is filed as `auto`, or attributed to whatever
   * unrelated slash command happened to run in between.
   */
  it("attributes a continuation's Skill call to the slash command that started the message", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "cafe08.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const userLine = (ts: string, text: string) =>
      JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } });
    await fs.writeFile(
      file,
      [
        // The slash command that actually initiated the message.
        userLine("2026-08-01T10:00:00Z", "<command-name>pr-resolve</command-name>\nresolve them"),
        line("2026-08-01T10:00:01Z", "msg_1", textBlock("Reading the comments.")),
        // An unrelated slash command lands between the message's two lines,
        // moving the cursor the buggy version consulted.
        userLine("2026-08-01T10:00:02Z", "<command-name>unrelated</command-name>\nsomething else"),
        line(
          "2026-08-01T10:00:03Z",
          "msg_1",
          toolBlock("tu_skill", "Skill", { skill: "pr-resolve" })
        ),
      ].join("\n") + "\n"
    );

    const db = (await conn.getDb())!;
    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const row = db
      .prepare(
        "SELECT skill_name, invocation_source FROM tool_uses WHERE session_id = 'cafe08' AND tool_name = 'Skill'"
      )
      .get() as { skill_name: string; invocation_source: string };
    expect(row.skill_name).toBe("pr-resolve");
    // Reading the live cursor here yields the `unrelated` window, which does
    // not contain `pr-resolve`, and the call is recorded as `auto`.
    expect(row.invocation_source).toBe("slash_command");
  });

  /**
   * A thinking block that arrives on a continuation line stays retrievable.
   *
   * `has_thinking` and `text_offset` have to agree: the timeline shows an
   * expandable thinking event from the flag, and `readThinkingFromJsonl` reads
   * exactly the ONE line the offset names. Merging set the flag from any line
   * while the offset still pointed at the message's first — so a message that
   * opened with text and thought afterwards advertised an event that resolved
   * to "Thinking content unavailable".
   */
  it("points text_offset at the line the thinking is actually on", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "cafe07.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:00Z",
          message: { content: [{ type: "text", text: "go" }] },
        }),
        // Text FIRST, thinking second — the order that broke retrieval.
        line("2026-08-01T10:00:01Z", "msg_1", textBlock("Starting now.")),
        line("2026-08-01T10:00:01Z", "msg_1", thinkingBlock("the tricky part is ordering")),
      ].join("\n") + "\n"
    );

    const db = (await conn.getDb())!;
    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const turn = db
      .prepare(
        "SELECT turn_index, has_thinking FROM turns WHERE session_id = 'cafe07' AND role = 'assistant'"
      )
      .get() as { turn_index: number; has_thinking: number };
    expect(turn.has_thinking).toBe(1);

    // The real reader, not a re-implementation of the offset arithmetic.
    const { readThinkingFromJsonl } = await import("@/lib/data/thinkingContent");
    const body = await readThinkingFromJsonl(db, "cafe07", turn.turn_index);
    expect(body).toContain("the tricky part is ordering");
  });

  /**
   * Subagent transcripts split their messages the same way.
   *
   * Sidechain rows carry no `tool_uses` by design, so the only thing that can
   * be lost here is prose — but that prose is the FTS body for delegated work,
   * which the sessions help page advertises as searchable. Covered separately
   * because the sidechain collector is a second implementation of the same
   * contract: without a test, deleting its merge leaves the suite green, and
   * two paths with one contract and asymmetric guards is the defect shape this
   * whole change exists to remove.
   */
  it("merges continuation blocks in subagent transcripts too", async () => {
    const { conn, mig, ingest } = await reload();
    expect((await mig.initDb()).error).toBeNull();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const file = path.join(projectsDir, "C--dev-myapp", "cafe06.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const sidechainLine = (block: unknown) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-01T10:00:01Z",
        isSidechain: true,
        message: {
          id: "sub_1",
          model: "claude-sonnet-4-5",
          content: [block],
          usage: USAGE,
        },
      });
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-01T10:00:00Z",
          message: { content: [{ type: "text", text: "delegate it" }] },
        }),
        sidechainLine(textBlock("subagent prose about the parser rewrite plan")),
        // A distinct second block, and then an exact re-log of the first.
        sidechainLine(thinkingBlock("subagent weighed a rewrite")),
        sidechainLine(textBlock("subagent prose about the parser rewrite plan")),
        // A genuinely new block whose body is a strict SUBSTRING of the first.
        // Deduping on "is this text already in there somewhere" would discard
        // it; only exact block identity keeps it.
        sidechainLine(thinkingBlock("rewrite plan")),
      ].join("\n") + "\n"
    );

    const db = (await conn.getDb())!;
    expect((await ingest.reconcileAllSessions(db, { projectsDir })).errors).toBe(0);

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'cafe06' AND is_sidechain = 1")
      .get() as { n: number };
    // One message, one row — tokens counted once, as on the primary path.
    expect(rows.n).toBe(1);

    // Read the indexed body rather than asking whether a term matches: a
    // presence check passes whether the re-logged block was deduped or
    // appended twice, so it cannot discriminate the guard it exists to cover.
    const indexed = (
      db.prepare("SELECT text FROM prompts_fts WHERE session_id = 'cafe06'").all() as Array<{
        text: string;
      }>
    )
      .map((r) => r.text)
      .join("\n");

    // The block that arrived on a continuation line is searchable at all…
    expect(indexed).toContain("subagent weighed a rewrite");
    // …the block that was re-logged appears exactly once…
    expect(indexed.split("subagent prose about the parser rewrite plan").length - 1).toBe(1);
    // …and the substring block survives on its own. Twice: once inside the
    // longer first block, once as itself. A substring-based dedupe would
    // report 1 here, silently losing a subagent's reasoning because an
    // earlier sentence happened to contain the same words.
    expect(indexed.split("rewrite plan").length - 1).toBe(2);
  });
});
