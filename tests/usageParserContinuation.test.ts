import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurns, parseSessionTurnsWithMeta } from "@/lib/usage/parser";
import { attributeContext } from "@/lib/usage/contextAttribution";

// #453 — Claude Code writes ONE JSONL LINE PER CONTENT BLOCK, all sharing one
// `message.id`. The file-parse path deduped by that id and `continue`d, which
// discarded every block after the first. Measured on one project: 4,164 write
// edits in the raw JSONL and in the SQLite index, 1,651 on the file path.
//
// Every fixture here spans one message across several lines. That shape is the
// whole point: the pre-existing suite is one-block-per-line throughout, which
// is exactly why 45 passing tests never saw this. Mutating the fix must fail
// these — verified by reverting to `continue` and re-running.

const MODEL = "claude-sonnet-4-6";

/** One line of a multi-line assistant message: same id, `usage` repeated verbatim. */
function assistantLine(id: string, ts: string, content: unknown[]) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: `req_${id}`,
    message: {
      id,
      model: MODEL,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 7 },
      content,
    },
  });
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: "tool_use", id, name, input };
}

async function withSession(
  lines: string[],
  fn: (file: string) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-cont-"));
  const file = path.join(dir, `sess-${Math.random().toString(36).slice(2)}.jsonl`);
  try {
    await fs.writeFile(file, `${lines.join("\n")}\n`);
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("parseSessionTurns — multi-line assistant messages (#453)", () => {
  it("keeps tool_use blocks that arrive on continuation lines", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "on it" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [toolUse("tu_1", "Edit", { file_path: "a.ts" })]),
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [toolUse("tu_2", "Bash", { command: "pnpm test" })]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        // One message is one turn, however many lines carried it.
        expect(turns.length).toBe(1);
        expect(turns[0].toolCalls.map((t) => t.name)).toEqual(["Edit", "Bash"]);
        expect(turns[0].toolCalls.map((t) => t.id)).toEqual(["tu_1", "tu_2"]);
      }
    );
  });

  it("counts the repeated usage block exactly once", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "hi" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [toolUse("tu_1", "Read")]),
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [toolUse("tu_2", "Grep")]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        // The reason the id guard exists at all: three lines each repeat the
        // message-level usage, and summing them would treble the bill.
        expect(turns[0].inputTokens).toBe(100);
        expect(turns[0].outputTokens).toBe(40);
        expect(turns[0].cacheReadTokens).toBe(7);
      }
    );
  });

  it("still drops a genuine re-log, which repeats its tool_use_id", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [toolUse("tu_1", "Edit")]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [toolUse("tu_2", "Bash")]),
        // Resumed-session re-emit: byte-identical to the first line.
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [toolUse("tu_1", "Edit")]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        expect(turns[0].toolCalls.map((t) => t.id)).toEqual(["tu_1", "tu_2"]);
      }
    );
  });

  it("still drops a re-logged tool block that carries no id", async () => {
    // Codex, PR #468. An id-less `tool_use` is a shape this module accepts —
    // `buildToolCalls` normalises a missing `name` to "unknown" — but with no
    // key it had no dedupe at all, so a re-log appended the block again. That is
    // strictly worse than the message-level guard it replaced, which discarded
    // the repeat outright.
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "on it" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
        ]),
        // Byte-identical re-emission, still with no id.
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
        ]),
        // Same tool, DIFFERENT input — a real second call, not a re-log.
        assistantLine("msg_a", "2026-08-19T10:00:03Z", [
          { type: "tool_use", name: "Edit", input: { file_path: "b.ts" } },
        ]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        const calls = turns[0].toolCalls;
        expect(calls).toHaveLength(2);
        expect(calls.map((t) => t.arguments?.file_path)).toEqual(["a.ts", "b.ts"]);
      }
    );
  });

  it("merges prose across lines and drops a repeated text block", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "first" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [{ type: "text", text: "second" }]),
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [{ type: "text", text: "first" }]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        expect(turns[0].assistantText).toBe("first\nsecond");
      }
    );
  });

  it("resolves tool errors for continuation blocks, not just first-line ones", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "running" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [toolUse("tu_1", "Bash", { command: "false" })]),
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-19T10:00:03Z",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "command not found: nope" },
            ],
          },
        }),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        const call = turns[0].toolCalls.find((t) => t.id === "tu_1");
        // The continuation path is not a reduced copy that forgets error lookup.
        expect(call?.isError).toBe(true);
        expect(call?.errorCategory).toBeTruthy();
      }
    );
  });

  it("attributes a split Skill call to its OWN prompt, not a later one", async () => {
    // The window is latched when the message opens. A continuation that lands
    // after a later user turn must not read the live cursor — that is the
    // ingest-path defect from PR #427, in miniature.
    await withSession(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-19T10:00:00Z",
          message: { content: [{ type: "text", text: "<command-name>pr-resolve</command-name>" }] },
        }),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [{ type: "text", text: "starting" }]),
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-19T10:00:02Z",
          message: { content: [{ type: "text", text: "<command-name>something-else</command-name>" }] },
        }),
        // Detached continuation of msg_a, arriving after that later prompt.
        assistantLine("msg_a", "2026-08-19T10:00:03Z", [
          toolUse("tu_1", "Skill", { skill: "pr-resolve" }),
        ]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        const skill = turns
          .flatMap((t) => t.toolCalls)
          .find((t) => t.id === "tu_1");
        expect(skill?.invocationSource).toBe("slash_command");
      }
    );
  });

  it("names a tool_use block that carries no name, matching the DB path", async () => {
    // `ToolCall.name` is required; a cast used to put a literal `undefined`
    // there, which becomes an "undefined" bucket in topTools and every other
    // grouping. `ingest.ts` normalizes the same case to "unknown", so the two
    // backends have to agree. (Copilot, PR #468.)
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "hm" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [
          { type: "tool_use", id: "tu_1", input: {} },
        ]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        expect(turns[0].toolCalls.map((t) => t.name)).toEqual(["unknown"]);
      }
    );
  });

  it("does not let one message consume the slash window twice", async () => {
    await withSession(
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-08-19T10:00:00Z",
          message: { content: [{ type: "text", text: "<command-name>pr-resolve</command-name>" }] },
        }),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [
          toolUse("tu_1", "Skill", { skill: "pr-resolve" }),
        ]),
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [
          toolUse("tu_2", "Skill", { skill: "pr-resolve" }),
        ]),
      ],
      async (file) => {
        const turns = await parseSessionTurns(file, "C--dev-proj");
        const assistant = turns.filter((t) => t.role === "assistant");
        expect(assistant.length).toBe(1);
        const sources = assistant[0].toolCalls.map((t) => t.invocationSource);
        expect(sources).toEqual(["slash_command", "auto"]);
      }
    );
  });
});

describe("parseSessionTurnsWithMeta — same fix, second loop (#453)", () => {
  // parser.ts runs two near-identical assistant loops. A fix landing in only
  // one is how this bug survived #426, so the second is pinned separately.
  it("keeps continuation tool_use blocks and counts usage once", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "on it" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [toolUse("tu_1", "Edit")]),
        assistantLine("msg_a", "2026-08-19T10:00:02Z", [toolUse("tu_2", "Bash")]),
      ],
      async (file) => {
        const { turns } = await parseSessionTurnsWithMeta(file, "C--dev-proj");
        expect(turns.length).toBe(1);
        expect(turns[0].toolCalls.map((t) => t.name)).toEqual(["Edit", "Bash"]);
        expect(turns[0].inputTokens).toBe(100);
      }
    );
  });

  it("reports thinking that arrives on a continuation line", async () => {
    await withSession(
      [
        assistantLine("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "hm" }]),
        assistantLine("msg_a", "2026-08-19T10:00:01Z", [
          { type: "thinking", thinking: "let me check the lockfile" },
        ]),
      ],
      async (file) => {
        const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-proj");
        expect(meta.hasThinking).toBe(true);
      }
    );
  });
});

describe("attributeContext — multi-line messages (#453)", () => {
  const entry = (id: string, ts: string, content: unknown[]) => ({
    type: "assistant" as const,
    timestamp: ts,
    requestId: `req_${id}`,
    message: {
      id,
      model: MODEL,
      usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
      content,
    },
  });

  it("attributes thinking and tool input carried on continuation lines", async () => {
    const thinking = "x".repeat(4000);
    const report = attributeContext("s1", [
      entry("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "short reply" }]),
      entry("msg_a", "2026-08-19T10:00:01Z", [{ type: "thinking", thinking }]),
      entry("msg_a", "2026-08-19T10:00:02Z", [
        { type: "tool_use", id: "tu_1", name: "Edit", input: { body: "y".repeat(4000) } },
      ]),
    ] as any);

    // Still one turn — continuation lines are the same message.
    expect(report.turns.length).toBe(1);
    // ...but its content is no longer thrown away and then reported as
    // "unattributed", which is what the drop used to produce.
    expect(report.turns[0].added.thinking).toBeGreaterThan(0);
    expect(report.turns[0].added.toolInput).toBeGreaterThan(0);
    expect(report.turns[0].addedTotal).toBe(
      report.turns[0].added.assistantText +
        report.turns[0].added.thinking +
        report.turns[0].added.toolInput
    );
  });

  it("does not double-count a re-logged block", async () => {
    const base = [
      entry("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "z".repeat(2000) }]),
      entry("msg_a", "2026-08-19T10:00:01Z", [
        { type: "tool_use", id: "tu_1", name: "Edit", input: { body: "y".repeat(2000) } },
      ]),
    ];
    const once = attributeContext("s1", base as any);
    const twice = attributeContext("s1", [...base, base[1]] as any);
    expect(twice.turns[0].addedTotal).toBe(once.turns[0].addedTotal);
  });

  it("counts a detached continuation's bytes against the later peak that saw them", async () => {
    // Codex, PR #468. A continuation can arrive long after its own first line —
    // ingest measured gaps up to 3,639 lines. If it lands after a LATER turn
    // has set the segment peak, its bytes still belong to a turn that preceded
    // that peak, so they were in the window the peak measured. Snapshotting the
    // running total when the peak was seen omits them and inflates
    // `unattributedTokens` by exactly that amount; deriving from turn order at
    // segment close does not care when the line showed up.
    const body = "y".repeat(8000);
    const detached = attributeContext("s1", [
      entry("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "starting" }]),
      // A later turn, and the one that measures the peak window.
      {
        ...entry("msg_b", "2026-08-19T10:00:05Z", [{ type: "text", text: "second" }]),
        message: {
          id: "msg_b",
          model: MODEL,
          usage: { input_tokens: 90000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: "text", text: "second" }],
        },
      },
      // ...and only NOW the rest of msg_a arrives.
      entry("msg_a", "2026-08-19T10:00:09Z", [
        { type: "tool_use", id: "tu_1", name: "Edit", input: { body } },
      ]),
    ] as any);

    // Same content, same order of turns, but the continuation adjacent to its
    // own first line — the arrangement whose numbers are not in dispute.
    const adjacent = attributeContext("s1", [
      entry("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "starting" }]),
      entry("msg_a", "2026-08-19T10:00:01Z", [
        { type: "tool_use", id: "tu_1", name: "Edit", input: { body } },
      ]),
      {
        ...entry("msg_b", "2026-08-19T10:00:05Z", [{ type: "text", text: "second" }]),
        message: {
          id: "msg_b",
          model: MODEL,
          usage: { input_tokens: 90000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: "text", text: "second" }],
        },
      },
    ] as any);

    // Where the line happened to sit in the file must not change the answer.
    expect(detached.segments[0].attributedAtPeak).toBe(adjacent.segments[0].attributedAtPeak);
    expect(detached.segments[0].unattributedTokens).toBe(
      adjacent.segments[0].unattributedTokens
    );
    // And the tool input really is on the counted side of the measurement.
    expect(detached.segments[0].attributedAtPeak).toBeGreaterThan(1000);
  });

  it("does not re-count a re-logged bare-string assistant message", async () => {
    // Codex, PR #468. The plain-string `message.content` shape is supported and
    // does occur; the array-shaped path was deduped at block level but this one
    // was not, so a genuine re-log was added to the turn twice. Before
    // continuations were merged at all the repeat line was dropped wholesale,
    // so the merge is what opened this.
    const line = {
      type: "assistant" as const,
      timestamp: "2026-08-19T10:00:00Z",
      requestId: "req_a",
      message: {
        id: "msg_a",
        model: MODEL,
        usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: "z".repeat(4000),
      },
    };
    const once = attributeContext("s1", [line] as any);
    const twice = attributeContext("s1", [line, line] as any);

    expect(twice.turns).toHaveLength(1);
    expect(twice.turns[0].addedTotal).toBe(once.turns[0].addedTotal);
    expect(twice.totals.assistantText).toBe(once.totals.assistantText);
  });

  it("counts a segment that opened on a leading compaction boundary", async () => {
    // Codex, PR #468 — a regression from deriving `attributedAtPeak` from turn
    // order rather than a running total. An EMPTY segment (a marker before any
    // turn, or two in a row) closed with its lower bound one past the turn that
    // then opened the next segment, so that turn fell outside `[segmentStart,
    // peakTurn)`. A session opening on a compaction boundary reported none of
    // the prompt that followed as attributed.
    const prompt = "u".repeat(6000);
    const withBoundary = attributeContext("s1", [
      { type: "system", subtype: "compact_boundary", timestamp: "2026-08-19T10:00:00Z" },
      { type: "user", timestamp: "2026-08-19T10:00:01Z", message: { content: prompt } },
      {
        type: "assistant",
        timestamp: "2026-08-19T10:00:02Z",
        message: {
          id: "msg_a",
          model: MODEL,
          usage: { input_tokens: 90000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: "text", text: "reply" }],
        },
      },
    ] as any);

    const seg = withBoundary.segments[withBoundary.segments.length - 1];
    // The prompt preceded the measured turn, so it WAS in the window the peak
    // measured — roughly 6000 bytes of it.
    expect(seg.attributedAtPeak).toBeGreaterThan(1000);
    // ...and the remainder shrinks by exactly what stopped being lost.
    expect(seg.unattributedTokens).toBe(90000 - seg.attributedAtPeak!);
  });

  it("keeps segment totals in step with the turn it merged into", async () => {
    const report = attributeContext("s1", [
      entry("msg_a", "2026-08-19T10:00:00Z", [{ type: "text", text: "a".repeat(1000) }]),
      entry("msg_a", "2026-08-19T10:00:01Z", [
        { type: "tool_use", id: "tu_1", name: "Edit", input: { body: "b".repeat(3000) } },
      ]),
    ] as any);
    const segTotal = report.segments[0].attributedTotal;
    const turnTotal = report.turns.reduce((n, t) => n + t.addedTotal, 0);
    expect(segTotal).toBe(turnTotal);
  });
});
