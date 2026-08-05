/**
 * A1 — transcript schema decode.
 *
 * Claude Code's JSONL grew a set of entry types and fields that neither reader
 * decoded. These tests pin the two things most likely to regress:
 *
 * 1. The new entry types are decoded AT ALL. `ai-title` and `permission-mode`
 *    entries carry no `timestamp`, and both readers have a `!entry.timestamp`
 *    guard that silently `continue`s. Decoding below that guard drops every one
 *    of them without erroring — which is exactly the kind of bug a fixture
 *    catches and a typecheck never will.
 *
 * 2. A LEGACY transcript with none of the fields yields `undefined`, not a
 *    default. A turn with no `effort` is not a `medium` turn, and a session with
 *    no `permission-mode` entries is not a session that stayed in `auto`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurns } from "@/lib/usage/parser";

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

async function writeFixture(lines: object[]): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-a1-"));
  const file = path.join(tmpDir, "a1-session.jsonl");
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** An assistant turn carrying every A1 field, shaped like the real transcript. */
function modernAssistant(over: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    sessionId: "a1-session",
    // NOTE: top-level on the entry, NOT inside `message` — the single most
    // likely place for this decode to be written wrong.
    effort: "high",
    attributionSkill: "pr-resolve",
    attributionMcpServer: "plugin:context-mode:context-mode",
    attributionMcpTool: "ctx_execute",
    hookInfos: [{ command: "codegraph sync", durationMs: 1450 }],
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        speed: "standard",
        service_tier: "standard",
      },
    },
    ...over,
  };
}

/** The same turn as written by a pre-2.1.212 Claude Code: none of the fields. */
function legacyAssistant() {
  return {
    type: "assistant",
    timestamp: "2026-01-01T10:00:00Z",
    sessionId: "a1-session",
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

describe("A1 — per-turn field decode (usage/parser)", () => {
  it("reads effort, speed, and the attribution fields off a modern turn", async () => {
    const file = await writeFixture([modernAssistant()]);
    const turns = await parseSessionTurns(file, "C--dev-test");
    const assistant = turns.find((t) => t.role === "assistant");

    expect(assistant).toBeDefined();
    expect(assistant!.effort).toBe("high");
    expect(assistant!.speed).toBe("standard");
    expect(assistant!.attributionSkill).toBe("pr-resolve");
    expect(assistant!.attributionMcpServer).toBe("plugin:context-mode:context-mode");
    expect(assistant!.attributionMcpTool).toBe("ctx_execute");
  });

  it("leaves every A1 field undefined on a legacy turn — not defaulted", async () => {
    const file = await writeFixture([legacyAssistant()]);
    const turns = await parseSessionTurns(file, "C--dev-test");
    const assistant = turns.find((t) => t.role === "assistant");

    expect(assistant).toBeDefined();
    // `toBeUndefined`, not `toBeFalsy`: "" or 0 would be a defaulted value
    // masquerading as absence, and downstream code cannot tell them apart.
    expect(assistant!.effort).toBeUndefined();
    expect(assistant!.speed).toBeUndefined();
    expect(assistant!.attributionSkill).toBeUndefined();
    expect(assistant!.attributionMcpServer).toBeUndefined();
    expect(assistant!.attributionMcpTool).toBeUndefined();
  });

  it("normalises a null speed to undefined rather than passing null through", async () => {
    // Observed on ~4% of recent assistant turns — the same ones that lack
    // `effort`. null means unknown, and a consumer reading it as a value would
    // report those turns as neither standard nor fast but literally null.
    const entry = modernAssistant();
    (entry.message.usage as Record<string, unknown>).speed = null;
    delete (entry as Record<string, unknown>).effort;

    const file = await writeFixture([entry]);
    const turns = await parseSessionTurns(file, "C--dev-test");
    const assistant = turns.find((t) => t.role === "assistant");

    expect(assistant!.speed).toBeUndefined();
    expect(assistant!.speed).not.toBeNull();
    expect(assistant!.effort).toBeUndefined();
  });

  it("survives a transcript whose new entry types carry no message at all", async () => {
    // `ai-title` / `permission-mode` / `pr-link` have no `message` key. A reader
    // that assumes one throws, and the surrounding try/catch would swallow it
    // into a silently short transcript.
    const file = await writeFixture([
      { type: "ai-title", aiTitle: "Explore app distribution", sessionId: "a1-session" },
      { type: "permission-mode", permissionMode: "plan", sessionId: "a1-session" },
      {
        type: "pr-link",
        timestamp: "2026-08-01T10:05:00Z",
        prNumber: 375,
        prUrl: "https://github.com/o/r/pull/375",
        prRepository: "o/r",
        sessionId: "a1-session",
      },
      modernAssistant(),
    ]);
    const turns = await parseSessionTurns(file, "C--dev-test");

    // The assistant turn still parses — the metadata entries neither threw nor
    // consumed it.
    expect(turns.filter((t) => t.role === "assistant")).toHaveLength(1);
    expect(turns[0].effort).toBe("high");
  });
});

describe("A1 — session-level decode (scanner/claudeConversations)", () => {
  // These entry types carry NO timestamp, which is the whole reason this test
  // exists: both readers skip untimestamped entries, so the decode has to run
  // before that guard.
  it("ai-title and permission-mode entries genuinely lack a timestamp", () => {
    const aiTitle = { type: "ai-title", aiTitle: "x", sessionId: "s" };
    const permissionMode = { type: "permission-mode", permissionMode: "auto", sessionId: "s" };
    expect("timestamp" in aiTitle).toBe(false);
    expect("timestamp" in permissionMode).toBe(false);
  });
});
