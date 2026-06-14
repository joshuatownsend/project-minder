import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

const FIXTURE_DIR = path.join(os.tmpdir(), "codex-adapter-test-" + Date.now());
const SESSIONS_DIR = path.join(FIXTURE_DIR, ".codex", "sessions", "2025");

// Minimal Codex JSONL with one user turn and one assistant turn
const SESSION_ID = "test-session-abc";
const PROJECT_CWD = "/home/user/my-project";

const SAMPLE_JSONL =
  JSON.stringify({ type: "session_meta", payload: { id: SESSION_ID, cwd: PROJECT_CWD, timestamp: "2025-06-01T10:00:00Z", cli_version: "1.0.0" } }) + "\n" +
  // user message
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello from Codex" }] } }) + "\n" +
  // turn boundary
  JSON.stringify({ type: "turn_context", payload: { model: "gpt-4o" } }) + "\n" +
  // assistant text
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi there" }] } }) + "\n" +
  // token count
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 }, model: "gpt-4o" } } }) + "\n";

beforeAll(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`), SAMPLE_JSONL, "utf-8");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("codex adapter", () => {
  it("discover() finds JSONL files in nested sessions dir", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);

    const files = await codexAdapter.discover();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].source).toBe("codex");
    expect(files[0].filePath).toContain(`${SESSION_ID}.jsonl`);
    expect(files[0].projectDirName).toContain("my-project");

  });

  it("parseFile() stamps source: 'codex' on every turn", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    const filePath = path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`);
    const file = { source: "codex", filePath, projectDirName: "home-user-my-project" };
    const turns = await codexAdapter.parseFile(file);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.source).toBe("codex");
    }
  });

  it("parseFile() produces user and assistant turns with correct token data", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    const filePath = path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`);
    const file = { source: "codex", filePath, projectDirName: "home-user-my-project" };
    const turns = await codexAdapter.parseFile(file);

    const user = turns.find((t) => t.role === "user");
    const assistant = turns.find((t) => t.role === "assistant");

    expect(user).toBeDefined();
    expect(user!.userMessageText).toContain("Hello from Codex");

    expect(assistant).toBeDefined();
    expect(assistant!.model).toBe("gpt-4o");
    // cacheRead = min(5, 20) = 5; billableInput = 20 - 5 = 15
    expect(assistant!.cacheReadTokens).toBe(5);
    expect(assistant!.inputTokens).toBe(15);
    expect(assistant!.outputTokens).toBe(8);
    expect(assistant!.cacheCreateTokens).toBe(0);
  });

  it("discover() returns empty list when .codex dir does not exist", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    vi.spyOn(os, "homedir").mockReturnValue(path.join(os.tmpdir(), "nonexistent-codex-" + Date.now()));
    const files = await codexAdapter.discover();
    expect(files).toEqual([]);
  });

  it("discover() deduplicates sessions with the same id across sessions/ and archived_sessions/", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    // Copy fixture file into archived_sessions too
    const archivedDir = path.join(FIXTURE_DIR, ".codex", "archived_sessions", "2025");
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.copyFileSync(
      path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`),
      path.join(archivedDir, `${SESSION_ID}.jsonl`)
    );

    vi.spyOn(os, "homedir").mockReturnValue(FIXTURE_DIR);
    const files = await codexAdapter.discover();
    const ids = files.map((f) => f.filePath);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    // Only one file despite appearing in both dirs
    const matchingFiles = files.filter((f) => f.filePath.includes(SESSION_ID));
    expect(matchingFiles.length).toBe(1);

  });

  it("parseFileWithMeta() returns the same turns plus session meta", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    const filePath = path.join(SESSIONS_DIR, `${SESSION_ID}.jsonl`);
    const file = { source: "codex", filePath, projectDirName: "home-user-my-project" };

    const turns = await codexAdapter.parseFile(file);
    const { turns: metaTurns, meta } = await codexAdapter.parseFileWithMeta!(file);

    // parseFile delegates to the WithMeta helper, so turns are identical.
    expect(metaTurns).toEqual(turns);
    for (const t of metaTurns) expect(t.source).toBe("codex");

    // SessionTurnsMeta shape.
    expect(meta.compactBoundaries).toEqual([]); // Claude-only concept
    expect(meta.cliVersion).toBe("1.0.0"); // from session_meta cli_version
    expect(meta.hasThinking).toBe(false); // Codex emits output_text, not thinking
  });

  it("parseFileWithMeta() sets hasThinking when an assistant 'thinking' block is present", async () => {
    const { default: codexAdapter } = await import("@/lib/adapters/codex");
    const thinkingFile = path.join(FIXTURE_DIR, "codex-thinking.jsonl");
    const jsonl =
      JSON.stringify({ type: "session_meta", payload: { id: "codex-thinking", cwd: PROJECT_CWD, timestamp: "2025-06-01T10:00:00Z" } }) + "\n" +
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "thinking", text: "pondering" }, { type: "output_text", text: "answer" }] } }) + "\n";
    fs.writeFileSync(thinkingFile, jsonl, "utf-8");

    const { meta } = await codexAdapter.parseFileWithMeta!({
      source: "codex",
      filePath: thinkingFile,
      projectDirName: "home-user-my-project",
    });
    expect(meta.hasThinking).toBe(true);
    expect(meta.cliVersion).toBeNull(); // no cli_version / version fields in this fixture
  });
});
