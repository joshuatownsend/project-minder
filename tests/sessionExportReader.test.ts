import { describe, it, expect, afterAll } from "vitest";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import {
  entryToMessage,
  readJsonlMessages,
  timelineToMessages,
  toExportMeta,
} from "@/lib/sessions/exportReader";
import type { SessionDetail, TimelineEvent } from "@/lib/types";

// ─── entryToMessage ──────────────────────────────────────────────────────────

describe("entryToMessage", () => {
  it("reads a bare-string user message", () => {
    // User turns are frequently written as a plain string rather than a
    // block array; treating content as always-array drops them entirely.
    const msg = entryToMessage(
      { type: "user", timestamp: "2026-07-30T10:00:00.000Z", message: { content: "run the tests" } },
      new Map(),
    );
    expect(msg?.role).toBe("user");
    expect(msg?.blocks).toEqual([{ kind: "text", text: "run the tests" }]);
  });

  it("reads text, thinking, and tool_use blocks off an assistant turn", () => {
    const msg = entryToMessage(
      {
        type: "assistant",
        timestamp: "2026-07-30T10:00:12.000Z",
        message: {
          model: "claude-opus-5",
          content: [
            { type: "thinking", thinking: "deciding" },
            { type: "text", text: "Running them." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      new Map(),
    );
    expect(msg?.model).toBe("claude-opus-5");
    expect(msg?.blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
    expect(msg?.blocks[2].input).toEqual({ command: "pnpm test" });
  });

  it("labels a tool_result with the tool that produced it", () => {
    // The result block carries only `tool_use_id`, so the name has to come
    // from the earlier `tool_use` — hence the shared map across entries.
    const toolNames = new Map<string, string>();
    entryToMessage(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
      toolNames,
    );
    const result = entryToMessage(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      },
      toolNames,
    );
    expect(result?.blocks[0]).toMatchObject({ kind: "tool_result", toolName: "Bash", text: "ok" });
  });

  it("flattens an array-shaped tool_result and names non-text parts", () => {
    const msg = entryToMessage(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "line one" }, { type: "image" }],
              is_error: true,
            },
          ],
        },
      },
      new Map(),
    );
    expect(msg?.blocks[0].text).toBe("line one\n[image]");
    expect(msg?.blocks[0].isError).toBe(true);
  });

  it("marks an API-error turn so it renders as a callout, not prose", () => {
    const msg = entryToMessage(
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { content: [{ type: "text", text: "529 overloaded" }] },
      },
      new Map(),
    );
    expect(msg?.blocks[0].kind).toBe("error");
  });

  it("skips harness bookkeeping and non-message entries", () => {
    expect(entryToMessage({ type: "system", timestamp: "x" }, new Map())).toBeNull();
    expect(
      entryToMessage({ type: "user", isMeta: true, message: { content: "hook output" } }, new Map()),
    ).toBeNull();
    expect(entryToMessage({}, new Map())).toBeNull();
  });

  it("returns null when every block was empty rather than an empty message", () => {
    const msg = entryToMessage(
      { type: "assistant", message: { content: [{ type: "text", text: "   " }] } },
      new Map(),
    );
    expect(msg).toBeNull();
  });

  it("tolerates malformed blocks inside an otherwise good turn", () => {
    const msg = entryToMessage(
      {
        type: "assistant",
        message: { content: [null, "not-an-object", { type: "text", text: "kept" }] as never },
      },
      new Map(),
    );
    expect(msg?.blocks).toEqual([{ kind: "text", text: "kept" }]);
  });

  it("records the sidechain flag so subagent turns can be filtered", () => {
    const msg = entryToMessage(
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } },
      new Map(),
    );
    expect(msg?.isSidechain).toBe(true);
  });
});

// ─── readJsonlMessages ───────────────────────────────────────────────────────

const tmpFiles: string[] = [];

async function writeJsonl(lines: string[]): Promise<string> {
  const file = path.join(os.tmpdir(), `minder-export-${Math.random().toString(36).slice(2)}.jsonl`);
  await fs.writeFile(file, lines.join("\n"), "utf-8");
  tmpFiles.push(file);
  return file;
}

afterAll(async () => {
  await Promise.all(tmpFiles.map((f) => fs.rm(f, { force: true })));
});

describe("readJsonlMessages", () => {
  it("parses a transcript and carries tool names across lines", async () => {
    const file = await writeJsonl([
      JSON.stringify({ type: "user", message: { content: "go" } }),
      JSON.stringify({ type: "system", subtype: "turn_duration", duration: 900 }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] },
      }),
    ]);
    const messages = await readJsonlMessages(file);
    expect(messages).toHaveLength(3); // the system entry is not a message
    expect(messages[2].blocks[0]).toMatchObject({ toolName: "Bash", text: "a.ts" });
  });

  it("skips a torn trailing line instead of failing the export", async () => {
    // Normal for a session still being written when the export runs.
    const file = await writeJsonl([
      JSON.stringify({ type: "user", message: { content: "go" } }),
      '{"type":"assistant","message":{"content":[{"type":"te',
    ]);
    const messages = await readJsonlMessages(file);
    expect(messages).toHaveLength(1);
  });

  it("returns nothing for an empty file", async () => {
    expect(await readJsonlMessages(await writeJsonl([]))).toEqual([]);
  });

  it("preserves full message text — the reason this path exists at all", async () => {
    // The index caps assistant text at 300–500 chars. A 5 000-char reply
    // must survive intact here, or the exporter has no advantage over
    // rendering `SessionDetail.timeline` directly.
    const long = "w".repeat(5_000);
    const file = await writeJsonl([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: long }] } }),
    ]);
    const messages = await readJsonlMessages(file);
    expect(messages[0].blocks[0].text).toHaveLength(5_000);
  });
});

// ─── timelineToMessages ──────────────────────────────────────────────────────

function detailWith(timeline: TimelineEvent[]): SessionDetail {
  return {
    sessionId: "s1",
    projectPath: "C:\\dev\\app",
    projectSlug: "app",
    projectName: "app",
    messageCount: timeline.length,
    userMessageCount: 0,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costEstimate: 1.5,
    toolUsage: {},
    modelsUsed: [],
    subagentCount: 0,
    errorCount: 0,
    isActive: false,
    status: "idle",
    skillsUsed: {},
    timeline,
    fileOperations: [],
    subagents: [],
  };
}

describe("timelineToMessages", () => {
  it("folds consecutive assistant events into one message", () => {
    // The timeline is a flat event list: text and its tool calls are
    // separate entries. One heading per entry would shred a single turn
    // into half a dozen sections.
    const messages = timelineToMessages(
      detailWith([
        { type: "user", content: "go" },
        { type: "assistant", content: "on it" },
        { type: "tool_use", content: "Bash: ls", toolName: "Bash", toolInput: { command: "ls" } },
        { type: "tool_use", content: "Read: a.ts", toolName: "Read" },
        { type: "user", content: "thanks" },
      ]),
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1].blocks).toHaveLength(3);
  });

  it("drops a thinking event whose content the index stored out of line", () => {
    // The DB path writes `content: ""` and lazy-fetches on expand, so
    // there is genuinely nothing to export for that event.
    const messages = timelineToMessages(
      detailWith([{ type: "thinking", content: "", turnIndex: 3 }]),
    );
    expect(messages).toEqual([]);
  });

  it("keeps a thinking event that does carry text", () => {
    const messages = timelineToMessages(detailWith([{ type: "thinking", content: "hmm" }]));
    expect(messages[0].blocks[0]).toEqual({ kind: "thinking", text: "hmm" });
  });

  it("maps an error event to an error block", () => {
    const messages = timelineToMessages(detailWith([{ type: "error", content: "API error" }]));
    expect(messages[0].blocks[0].kind).toBe("error");
  });
});

// ─── toExportMeta ────────────────────────────────────────────────────────────

describe("toExportMeta", () => {
  it("carries the fidelity through so the document can declare it", () => {
    const meta = toExportMeta(detailWith([]), "index");
    expect(meta.fidelity).toBe("index");
    expect(meta.sessionId).toBe("s1");
    expect(meta.costEstimate).toBe(1.5);
  });
});
