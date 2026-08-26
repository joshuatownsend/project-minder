import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("finds adapter sessions on an install with no Claude projects tree", async () => {
    // The sweep used to `return new Map()` as soon as no Claude project
    // directories were readable. That predated adapter discovery and became a
    // hole the moment the merge was added: a Codex-only install has zero Claude
    // subdirs, so it returned empty before reaching the adapters — the file
    // backend reporting an empty corpus for precisely the users this feature
    // exists to serve. (Codex P1, PR #490.)
    //
    // `beforeEach` writes a Claude session, so remove the whole tree to model
    // the install rather than merely pointing somewhere empty.
    await fs.rm(path.join(tmpHome, ".claude"), { recursive: true, force: true });
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const sessions = await parseAllSessions();

    expect(sessions.has(CODEX_SESSION_ID)).toBe(true);
    expect(sessions.has(CLAUDE_SESSION_ID)).toBe(false);
  });

  it("skips an adapter transcript over the size cap, as the index does", async () => {
    // `MAX_SESSION_FILE_SIZE` is 50 MiB and both adapter parsers read the whole
    // file with `fs.readFile`, five concurrently. Memory is the obvious reason
    // for the cap, but the reason it belongs in THIS change is narrower:
    // `reconcileAdapterSessionFile` skips oversized files on the SQL side
    // (`ingest.ts:3706`), so parsing them here would make the fallback include
    // sessions the index deliberately excludes — a fresh divergence introduced
    // by the change that closes one. (Codex P2 + Copilot, PR #490.)
    //
    // Written as a sparse file so the test costs no real disk or time; the cap
    // reads `stat.size`, which a sparse file reports at its full length.
    await writeCodexSession();
    const target = path.join(codexHome, "sessions", "2026", `${CODEX_SESSION_ID}.jsonl`);
    const fh = await fs.open(target, "r+");
    try {
      await fh.truncate(51 * 1024 * 1024);
    } finally {
      await fh.close();
    }
    expect((await fs.stat(target)).size).toBeGreaterThan(50 * 1024 * 1024);

    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");

    const sessions = await parseAllSessions();

    expect(sessions.has(CODEX_SESSION_ID)).toBe(false);
    // The rest of the sweep is unaffected — an oversized file is skipped, not
    // fatal.
    expect(sessions.has(CLAUDE_SESSION_ID)).toBe(true);
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

  it("keeps portfolio yield scoped to the requested source", async () => {
    // `augmentPortfolioYield` re-reads the FULL session map rather than reusing
    // the report's already-filtered turns, and `gatherProjectTurns` matches on
    // project identity alone. That was harmless while the map only ever held
    // Claude sessions; giving file-parse adapter discovery is what made it a
    // leak — a `source=claude` report would classify Codex sessions into its
    // yield while every other figure covered Claude only. (Codex P2, PR #490.)
    //
    // Asserted at the seam rather than through `computeProjectYield`, which
    // shells out to git and would need a real repository: what the fix changes
    // is which turns reach it.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");
    const { gatherProjectTurns } = await import("@/lib/usage/projectMatch");
    const { scopeSessionMap } = await import("@/lib/usage/aggregator");

    const full = await parseAllSessions();
    // The production helper, not a re-implementation of it — otherwise this
    // test would pass whatever `augmentPortfolioYield` actually does.
    const scoped = scopeSessionMap(full, { source: "claude" });

    // Both sessions carry the same project identity, which is what makes the
    // leak possible at all — the filter is the only thing separating them.
    expect(gatherProjectTurns(full, "dev-app-x", CODEX_CWD).some((t) => t.source === "codex")).toBe(
      true
    );
    expect(
      gatherProjectTurns(scoped, "dev-app-x", CODEX_CWD).some((t) => t.source === "codex")
    ).toBe(false);

    // No scope requested leaves the map alone — the unfiltered path callers
    // take when the report covers everything.
    expect(scopeSessionMap(full, {})).toBe(full);

    // **The home axis, which was missed on the first pass at this fix.** An
    // adapter turn carries no `homeKey`, and the report-level filter is strict
    // equality — "excluded rather than guessed" — so ANY home scope must drop
    // the Codex session, not merely a mismatched one. Asserted against a home
    // the Claude session really does carry, so this cannot pass by filtering
    // everything away.
    const claudeTurns = full.get(CLAUDE_SESSION_ID)!;
    const claudeHomeKey = claudeTurns[0].homeKey;
    expect(claudeHomeKey).toBeTruthy();

    const homeScoped = scopeSessionMap(full, { home: claudeHomeKey });
    expect(homeScoped.has(CLAUDE_SESSION_ID)).toBe(true);
    expect(homeScoped.has(CODEX_SESSION_ID)).toBe(false);
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

describe("adapter read failures are not cached as empty (#498)", () => {
  /**
   * Mock a one-shot read failure on `filePath`, letting every other read
   * through. Returns the spy so the caller can restore WITHOUT touching the
   * file — which is the whole point: mtime and size stay exactly as they were
   * during the failed sweep, so anything cached then is still keyed valid.
   */
  function failReadsOf(filePath: string) {
    const real = fs.readFile;
    return vi.spyOn(fs, "readFile").mockImplementation((async (
      p: Parameters<typeof fs.readFile>[0],
      ...rest: unknown[]
    ) => {
      if (p === filePath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (real as never as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
  }

  it("retries an adapter transcript that was briefly unreadable", async () => {
    // This defect had been live on the usage surface since #490 and was never
    // reported: `mergeAdapterSessions` caught inside the cache factory, so an
    // EACCES became a cached `[]` and the session vanished from every usage
    // aggregate until a restart. It was found twice on the session list
    // (#495) because a missing row there is visible; a missing session in a
    // total is not.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");
    const file = path.join(codexHome, "sessions", "2026", `${CODEX_SESSION_ID}.jsonl`);

    const spy = failReadsOf(file);
    const blocked = await parseAllSessions();
    expect(blocked.has(CODEX_SESSION_ID)).toBe(false);
    // The Claude session is unaffected — a per-file skip, not an aborted sweep.
    expect(blocked.has(CLAUDE_SESSION_ID)).toBe(true);

    spy.mockRestore();
    const after = await parseAllSessions();
    expect(after.has(CODEX_SESSION_ID)).toBe(true);
  });

  it("retries a CLAUDE transcript that was briefly unreadable", async () => {
    // The same hole on the biggest corpus in the app, and outside the
    // `SessionAdapter` contract entirely: `parseSessionTurns` swallowed the
    // read error on its own account, so the sweep cached `[]` for it. The
    // `strict` option that fixes this already existed and nothing used it.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { parseAllSessions } = await import("@/lib/usage/parser");
    const file = path.join(
      tmpHome, ".claude", "projects", "C--dev-app-x", `${CLAUDE_SESSION_ID}.jsonl`
    );

    const spy = failReadsOf(file);
    const blocked = await parseAllSessions();
    expect(blocked.has(CLAUDE_SESSION_ID)).toBe(false);
    expect(blocked.has(CODEX_SESSION_ID)).toBe(true);

    spy.mockRestore();
    const after = await parseAllSessions();
    expect(after.has(CLAUDE_SESSION_ID)).toBe(true);
  });
});
