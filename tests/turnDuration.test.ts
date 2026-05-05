/**
 * Tests for turn_duration system entry attachment in parseSessionTurnsWithMeta.
 *
 * Key invariant: turn_duration.parentUuid points at stop_hook_summary, NOT
 * the assistant turn. The correct attachment strategy is "walk backward to the
 * nearest preceding assistant turn in stream order" — implemented by tracking
 * `lastAssistantTurnIdx` through the parse loop.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurnsWithMeta } from "@/lib/usage/parser";

describe("parseSessionTurnsWithMeta – turn_duration attachment", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function writeFixture(lines: object[]): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-td-"));
    const file = path.join(tmpDir, "test-session.jsonl");
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  it("attaches duration to the nearest preceding assistant turn", async () => {
    // Stream order: assistant → (tool_result user) → system(stop_hook_summary)
    //               → system(turn_duration)
    // parentUuid of turn_duration points at stop_hook_summary (uuid: "hook1"),
    // NOT at the assistant (uuid: "asst1"). Correct attachment: assistant.
    const assistantUuid = "asst1";
    const hookUuid = "hook1";
    const sessionId = "test-session";
    const durationMs = 62_343_392; // ~17h, matches real PAL-X fixture scale

    const lines = [
      {
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: null,
        timestamp: "2026-05-01T10:00:00Z",
        sessionId,
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 1000, output_tokens: 500 },
          content: [{ type: "text", text: "Here is the answer." }],
        },
      },
      {
        type: "user",
        uuid: "user1",
        parentUuid: assistantUuid,
        timestamp: "2026-05-01T10:00:01Z",
        sessionId,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      },
      {
        type: "system",
        subtype: "stop_hook_summary",
        uuid: hookUuid,
        parentUuid: "user1",
        timestamp: "2026-05-01T10:00:02Z",
        sessionId,
      },
      {
        type: "system",
        subtype: "turn_duration",
        // parentUuid points at stop_hook_summary — this is the real JSONL shape
        parentUuid: hookUuid,
        timestamp: "2026-05-01T10:00:02Z",
        sessionId,
        duration: durationMs,
      },
    ];

    const file = await writeFixture(lines);
    const { turns } = await parseSessionTurnsWithMeta(file, "C--dev-test");

    const assistantTurn = turns.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn?.turnDurationMs).toBe(durationMs);
  });

  it("does not attach duration when there is no preceding assistant turn", async () => {
    const sessionId = "test-session";
    const lines = [
      {
        type: "user",
        uuid: "user1",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId,
        message: { content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "system",
        subtype: "turn_duration",
        parentUuid: "user1",
        timestamp: "2026-05-01T10:00:01Z",
        sessionId,
        duration: 5000,
      },
    ];

    const file = await writeFixture(lines);
    const { turns } = await parseSessionTurnsWithMeta(file, "C--dev-test");

    for (const t of turns) {
      expect(t.turnDurationMs).toBeUndefined();
    }
  });

  it("attaches each duration to its own nearest assistant turn when multiple turns exist", async () => {
    const sessionId = "test-session";
    const lines = [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId,
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "First." }],
        },
      },
      {
        type: "system",
        subtype: "turn_duration",
        parentUuid: "a1",
        timestamp: "2026-05-01T10:00:01Z",
        sessionId,
        duration: 1000,
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-05-01T10:00:02Z",
        sessionId,
        message: { content: [{ type: "text", text: "Again" }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-05-01T10:00:03Z",
        sessionId,
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 200, output_tokens: 100 },
          content: [{ type: "text", text: "Second." }],
        },
      },
      {
        type: "system",
        subtype: "turn_duration",
        parentUuid: "a2",
        timestamp: "2026-05-01T10:00:04Z",
        sessionId,
        duration: 2000,
      },
    ];

    const file = await writeFixture(lines);
    const { turns } = await parseSessionTurnsWithMeta(file, "C--dev-test");

    const assistants = turns.filter((t) => t.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].turnDurationMs).toBe(1000);
    expect(assistants[1].turnDurationMs).toBe(2000);
  });
});
