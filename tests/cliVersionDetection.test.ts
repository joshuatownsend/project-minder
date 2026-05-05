/**
 * Tests for CLI version extraction in parseSessionTurnsWithMeta.
 * The "most-frequent version wins" rule mirrors the primary_model precedent
 * in ingest.ts's modelCounts map.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseSessionTurnsWithMeta } from "@/lib/usage/parser";

describe("parseSessionTurnsWithMeta – cliVersion extraction", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function writeFixture(lines: object[]): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minder-cv-"));
    const file = path.join(tmpDir, "test-session.jsonl");
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  function assistantEntry(version: string, idx: number): object {
    return {
      type: "assistant",
      version,
      timestamp: `2026-05-01T10:00:0${idx}Z`,
      sessionId: "test-session",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: "text", text: "Hello." }],
      },
    };
  }

  it("returns null when no version field is present", async () => {
    const lines = [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00Z",
        sessionId: "test-session",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "Hello." }],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.cliVersion).toBeNull();
  });

  it("returns the only version when all entries agree", async () => {
    const lines = [
      assistantEntry("2.1.119", 0),
      assistantEntry("2.1.119", 1),
      assistantEntry("2.1.119", 2),
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.cliVersion).toBe("2.1.119");
  });

  it("returns the most-frequent version on mid-session upgrade (5×v1 vs 3×v2)", async () => {
    const lines = [
      assistantEntry("2.1.119", 0),
      assistantEntry("2.1.119", 1),
      assistantEntry("2.1.119", 2),
      assistantEntry("2.1.119", 3),
      assistantEntry("2.1.119", 4),
      assistantEntry("2.1.120", 5),
      assistantEntry("2.1.120", 6),
      assistantEntry("2.1.120", 7),
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    expect(meta.cliVersion).toBe("2.1.119");
  });

  it("version appears on non-assistant entries too (system, user)", async () => {
    const lines = [
      { type: "user", version: "2.1.75", timestamp: "2026-05-01T10:00:00Z", sessionId: "s", message: { content: [] } },
      { type: "user", version: "2.1.75", timestamp: "2026-05-01T10:00:01Z", sessionId: "s", message: { content: [] } },
      {
        type: "assistant",
        version: "2.1.80",
        timestamp: "2026-05-01T10:00:02Z",
        sessionId: "s",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "Hi" }],
        },
      },
    ];
    const file = await writeFixture(lines);
    const { meta } = await parseSessionTurnsWithMeta(file, "C--dev-test");
    // 2.1.75 appears twice (user entries), 2.1.80 appears once
    expect(meta.cliVersion).toBe("2.1.75");
  });
});
