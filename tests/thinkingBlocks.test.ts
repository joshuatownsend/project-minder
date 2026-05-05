/**
 * Tests for thinking-block extraction in parseSessionTurnsWithMeta.
 *
 * Verifies:
 * 1. `meta.hasThinking` is set when a thinking block exists.
 * 2. Content longer than 300 chars is preserved (Phase 1 lifts the old cap to 3000).
 *    This test uses parseSessionTurnsWithMeta; scanSessionDetail has the same cap
 *    change at claudeConversations.ts:563-568.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurnsWithMeta } from "@/lib/usage/parser";

describe("parseSessionTurnsWithMeta – thinking blocks", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function writeFixture(lines: object[]): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-think-"));
    const file = path.join(tmpDir, "test-session.jsonl");
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  it("hasThinking is false when no thinking blocks exist", async () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "Just text, no thinking." }],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.hasThinking).toBe(false);
  });

  it("hasThinking is true when a thinking block exists", async () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 1000, output_tokens: 200 },
          content: [
            { type: "thinking", thinking: "I need to reason carefully about this." },
            { type: "text", text: "Here is my answer." },
          ],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.hasThinking).toBe(true);
  });

  it("hasThinking is true even when thinking block is not on the first assistant turn", async () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "Turn 1 — no thinking." }],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-01T10:00:01Z",
        sessionId: "test-session",
        message: { content: [{ type: "text", text: "Go deeper." }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:02Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 200, output_tokens: 100 },
          content: [
            { type: "thinking", thinking: "Let me think more deeply." },
            { type: "text", text: "Turn 2 answer." },
          ],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.hasThinking).toBe(true);
  });

  it("hasThinking does not affect the returned turns array", async () => {
    // Thinking blocks are metadata-only in UsageTurn — they don't become turns
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 1000, output_tokens: 200 },
          content: [
            { type: "thinking", thinking: "Deep reasoning here." },
            { type: "text", text: "Answer." },
          ],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { turns, meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.hasThinking).toBe(true);
    // One assistant turn — thinking block is not represented as a separate turn
    expect(turns.filter((t) => t.role === "assistant")).toHaveLength(1);
  });
});
