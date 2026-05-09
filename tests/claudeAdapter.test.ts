import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

const FIXTURE_DIR = path.join(os.tmpdir(), "claude-adapter-test-" + Date.now());
const PROJECTS_DIR = path.join(FIXTURE_DIR, ".claude", "projects");

const SAMPLE_JSONL = JSON.stringify({
  type: "user",
  uuid: "aa",
  timestamp: "2025-01-01T00:00:00Z",
  message: { content: [{ type: "text", text: "Hello" }] },
}) + "\n" + JSON.stringify({
  type: "assistant",
  uuid: "bb",
  timestamp: "2025-01-01T00:01:00Z",
  message: {
    content: [{ type: "text", text: "Hi there" }],
    model: "claude-opus-4-7",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
}) + "\n";

beforeAll(() => {
  const projectDir = path.join(PROJECTS_DIR, "C--test-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "testsession.jsonl"), SAMPLE_JSONL, "utf-8");
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("claude adapter", () => {
  it("discover() finds JSONL files in the fixture projects dir", async () => {
    const { default: claudeAdapter } = await import("@/lib/adapters/claude");
    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);

    const files = await claudeAdapter.discover();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].source).toBe("claude");
    expect(files[0].filePath).toContain("testsession.jsonl");
    expect(files[0].projectDirName).toBe("C--test-project");

    vi.mocked(os.homedir).mockRestore();
  });

  it("parseFile stamps source: 'claude' on every turn", async () => {
    const { default: claudeAdapter } = await import("@/lib/adapters/claude");
    const filePath = path.join(PROJECTS_DIR, "C--test-project", "testsession.jsonl");
    const file = { source: "claude", filePath, projectDirName: "C--test-project" };
    const turns = await claudeAdapter.parseFile(file);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.source).toBe("claude");
    }
  });

  it("parseFileWithMeta returns { turns, meta } with source stamps", async () => {
    const { default: claudeAdapter } = await import("@/lib/adapters/claude");
    const filePath = path.join(PROJECTS_DIR, "C--test-project", "testsession.jsonl");
    const file = { source: "claude", filePath, projectDirName: "C--test-project" };
    const result = await claudeAdapter.parseFileWithMeta!(file);
    expect(result).toHaveProperty("turns");
    expect(result).toHaveProperty("meta");
    expect(result.meta).toHaveProperty("compactBoundaries");
    expect(result.meta).toHaveProperty("cliVersion");
    expect(result.meta).toHaveProperty("hasThinking");
    for (const t of result.turns) {
      expect(t.source).toBe("claude");
    }
  });

  it("discover() returns empty list when projects dir does not exist", async () => {
    const { default: claudeAdapter } = await import("@/lib/adapters/claude");
    vi.spyOn(os, "homedir").mockReturnValue(path.join(os.tmpdir(), "nonexistent-" + Date.now()));
    const files = await claudeAdapter.discover();
    expect(files).toEqual([]);
    vi.mocked(os.homedir).mockRestore();
  });
});
