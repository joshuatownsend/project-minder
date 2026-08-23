import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

// #475: the file-parse pipeline had no adapter discovery, so it saw Claude and
// nothing else while the SQL backend indexed every enabled adapter. The two
// backends were therefore not equivalent, and `fileParseCoversCorpus` had to
// refuse to divert whenever adapter sessions existed — which left exactly those
// users carrying the #472 defect.
//
// **This machine cannot verify the feature by observation.** The reference index
// holds 6,799 sessions, every one of them `source = 'claude'`, with `codex`
// enabled in config for months against zero Codex transcripts. So the fixture
// below IS the evidence, and the empty-but-enabled case that this machine
// actually represents is pinned separately rather than assumed harmless.
//
// The seam is `CODEX_HOME`, which the adapter resolves before `~/.codex`
// (`codex.ts:28`) — no homedir spy, so it survives into any child process.

const state = installIsolatedState({
  prefix: "pm-usage-adapters-",
  extraGlobals: ["__usageFileCache", "__usageAllSessionsInFlight", "__usageCache"],
  preserveEnv: ["MINDER_USE_DB"],
});

let tmpHome: string;
let codexHome: string;

const CODEX_SESSION_ID = "codex-session-aaaa-bbbb";
const CODEX_CWD = "C:\\dev\\app-x";

/** Minimal Codex transcript: meta line, a user turn, a model, and token usage. */
const CODEX_JSONL =
  JSON.stringify({
    type: "session_meta",
    payload: {
      id: CODEX_SESSION_ID,
      cwd: CODEX_CWD,
      timestamp: "2026-04-15T10:00:00Z",
      cli_version: "1.0.0",
    },
  }) +
  "\n" +
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] },
  }) +
  "\n" +
  JSON.stringify({ type: "turn_context", payload: { model: "gpt-4o" } }) +
  "\n" +
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
  }) +
  "\n" +
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 },
        model: "gpt-4o",
      },
    },
  }) +
  "\n";

const CLAUDE_SESSION_ID = "aaaaaaaa-4444-4444-4444-444455556666";

async function writeClaudeSession(): Promise<void> {
  const dir = path.join(tmpHome, ".claude", "projects", "C--dev-app-x");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    {
      type: "user",
      timestamp: "2026-04-15T10:00:00Z",
      message: { content: [{ type: "text", text: "do task" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-04-15T10:00:01Z",
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  ];
  await fs.writeFile(
    path.join(dir, `${CLAUDE_SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
}

async function writeCodexSession(): Promise<void> {
  const dir = path.join(codexHome, "sessions", "2026");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${CODEX_SESSION_ID}.jsonl`), CODEX_JSONL);
}

/** Write the isolated `.minder.json` the reloaded `config.ts` will read. */
async function writeConfigFile(enabledAdapters: string[]): Promise<void> {
  const stateDir = process.env.MINDER_STATE_DIR!;
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, ".minder.json"),
    JSON.stringify({ statuses: {}, hidden: [], enabledAdapters }, null, 2)
  );
}

beforeEach(async () => {
  tmpHome = state.tmpHome();
  codexHome = path.join(tmpHome, "codex-home");
  process.env.CODEX_HOME = codexHome;
  await writeClaudeSession();
});

afterEach(() => {
  delete process.env.CODEX_HOME;
});

describe("file-parse adapter discovery (#475)", () => {
  it("merges an enabled adapter's sessions into the all-sessions map", async () => {
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const sessions = await parseAllSessions();

    // Keyed by the id the turns carry (`session_meta.id`), not the basename —
    // they coincide in this fixture, so assert the turns' own id too, or the
    // test would pass on a basename key that disagrees with what ingest stores.
    expect(sessions.has(CODEX_SESSION_ID)).toBe(true);
    const codexTurns = sessions.get(CODEX_SESSION_ID)!;
    expect(codexTurns.length).toBeGreaterThan(0);
    expect(codexTurns[0].sessionId).toBe(CODEX_SESSION_ID);
    expect(codexTurns.every((t) => t.source === "codex")).toBe(true);

    // The Claude corpus is still there — the merge adds, never replaces.
    expect(sessions.has(CLAUDE_SESSION_ID)).toBe(true);
  });

  it("does not see adapter sessions when the adapter is not enabled", async () => {
    await writeCodexSession();
    await writeConfigFile(["claude"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const sessions = await parseAllSessions();

    // Discoverable on disk but switched off in config: the walk must respect
    // the config, not the filesystem. Without this the setting would do nothing.
    expect(sessions.has(CODEX_SESSION_ID)).toBe(false);
    expect(sessions.has(CLAUDE_SESSION_ID)).toBe(true);
  });

  it("is a no-op when an adapter is enabled but has no sessions", async () => {
    // This machine's actual state, and the reason it cannot verify the feature
    // by observation: `codex` has been enabled for months against zero Codex
    // transcripts. Pinned explicitly so "enabled" can never start costing a
    // Claude-only user their corpus.
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const sessions = await parseAllSessions();

    expect(sessions.has(CLAUDE_SESSION_ID)).toBe(true);
    expect(sessions.size).toBe(1);
  });

  it("survives an adapter whose discovery throws", async () => {
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const adapters = await import("@/lib/adapters");
    const codex = adapters.getAdapter("codex")!;
    const original = codex.discover;
    codex.discover = async () => {
      throw new Error("unreadable CODEX_HOME");
    };
    try {
      const { parseAllSessions } = await import("@/lib/usage/parser");
      const sessions = await parseAllSessions();
      // An unreadable adapter home must not take down /usage for a Claude
      // corpus that parsed perfectly. Short by one source beats empty.
      expect(sessions.has(CLAUDE_SESSION_ID)).toBe(true);
    } finally {
      codex.discover = original;
    }
  });

  it("reaches the usage report as its own source", async () => {
    // The merge is only worth anything if the aggregate reflects it. This is the
    // end-to-end assertion the map-level tests above cannot make.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { generateUsageReport } = await import("@/lib/usage/aggregator");

    // `generateUsageReport` calls `parseAllSessions` itself.
    const report = await generateUsageReport("all");

    const sources = report.bySource?.map((s) => s.source) ?? [];
    expect(sources).toContain("codex");
    expect(sources).toContain("claude");

    // And a source-scoped report answers about that source alone — the filter
    // the DB backend applies as `WHERE source = ?`.
    const codexOnly = await generateUsageReport("all", undefined, "codex");
    expect(codexOnly.totalTokens).toBeGreaterThan(0);
    expect((codexOnly.bySource ?? []).map((s) => s.source)).toEqual(["codex"]);
  });
});
