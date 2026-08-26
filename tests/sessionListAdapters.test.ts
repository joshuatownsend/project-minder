/**
 * #489 — the session list gains adapter discovery, the last half of #475.
 *
 * `scanAllSessions` walked `<claude-home>/projects/**` and stopped, so the file
 * backend listed Claude sessions while the SQLite backend listed every enabled
 * adapter. That gap is the entire reason `fileParseCoversCorpus` existed: with
 * an adapter installed, diverting `getSessionsList` during a first reconcile
 * would have traded a partial view of every source for a complete view of one,
 * so it refused — and left exactly those users carrying the #472 defect.
 *
 * **The bar this file has to clear is "real fields", not "a longer list".** A
 * summary of nulls would satisfy a length assertion and render as a blank card,
 * so the assertions below are on populated content, and the last test compares
 * the same fixture through BOTH backends field by field. That is what converts
 * "the derivation is shared with ingest" from a claim about the code into
 * something a test can fail on.
 *
 * **This machine cannot verify any of it by observation** — the reference index
 * holds 6,799 sessions, every one `source = 'claude'`, with `codex` enabled for
 * months against zero Codex transcripts. The `CODEX_HOME` fixture seam IS the
 * evidence, and it survives into child processes because the adapter resolves
 * the env var before `~/.codex` rather than through a homedir spy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";
import type { SessionSummary } from "@/lib/types";

const state = installIsolatedState({
  prefix: "pm-session-adapters-",
  extraGlobals: [
    "__usageFileCache",
    "__usageAllSessionsInFlight",
    "__usageCache",
    "__sessionScanCache",
    "__sessionIndex",
  ],
  preserveEnv: ["MINDER_USE_DB"],
});

let tmpHome: string;
let codexHome: string;

const CODEX_SESSION_ID = "codex-session-aaaa-bbbb";
const CODEX_CWD = "C:\\dev\\app-x";
const CLAUDE_SESSION_ID = "aaaaaaaa-4444-4444-4444-444455556666";

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
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "refactor the parser" }],
    },
  }) +
  "\n" +
  JSON.stringify({ type: "turn_context", payload: { model: "gpt-4o" } }) +
  "\n" +
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "renamed the tokenizer" }],
    },
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

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

describe("session list adapter discovery (#489)", () => {
  it("lists an enabled adapter's session with real fields, not an empty shell", async () => {
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");

    const sessions = await scanAllSessions();
    const codex = sessions.find((s) => s.sessionId === CODEX_SESSION_ID);

    // Keyed on the id the turns carry (`session_meta.payload.id`), never the
    // basename. They coincide in this fixture, so the id is asserted from the
    // summary rather than inferred from the filename — a basename key would
    // disagree with what ingest stores, and every "same corpus" claim rests on
    // those two agreeing.
    expect(codex).toBeDefined();
    expect(codex!.source).toBe("codex");

    // The fields a blank card would leave empty. This is the assertion set the
    // issue asks for: a summary of nulls passes a length check and renders as
    // nothing.
    expect(codex!.initialPrompt).toContain("refactor the parser");
    expect(codex!.modelsUsed).toContain("gpt-4o");
    expect(codex!.messageCount).toBeGreaterThan(0);
    expect(codex!.assistantMessageCount).toBeGreaterThan(0);
    expect(codex!.userMessageCount).toBeGreaterThan(0);
    // The Codex adapter reports `input_tokens` INCLUSIVE of
    // `cached_input_tokens` and splits them, so 20 arrives as 15 uncached + 5
    // cache-read. Asserted as the split rather than the total, because the
    // split is the part a hand-written derivation would get wrong.
    expect(codex!.inputTokens).toBe(15);
    expect(codex!.cacheReadTokens).toBe(5);
    expect(codex!.outputTokens).toBe(8);
    expect(codex!.startTime).toBeTruthy();
    expect(codex!.projectSlug).toBeTruthy();
    expect(codex!.searchableText).toContain("refactor the parser");

    // Always `idle`, and that is a match rather than a shortcut: ingest stores
    // `storedStatus: "inactive"` for every adapter session, so the DB backend
    // never shows one as `working`.
    expect(codex!.status).toBe("idle");

    // The merge adds; it never replaces.
    expect(sessions.some((s) => s.sessionId === CLAUDE_SESSION_ID)).toBe(true);
  });

  it("does not list adapter sessions when the adapter is not enabled", async () => {
    await writeCodexSession();
    await writeConfigFile(["claude"]);
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");

    const sessions = await scanAllSessions();
    expect(sessions.some((s) => s.sessionId === CODEX_SESSION_ID)).toBe(false);
    expect(sessions.some((s) => s.sessionId === CLAUDE_SESSION_ID)).toBe(true);
  });

  it("lists the adapter session on a Claude-less install", async () => {
    // The case the #475 P1 was about, one surface over: an install with no
    // Claude projects tree at all. An early return keyed on the Claude walk
    // finding nothing would leave this user with an empty list rather than
    // their own sessions.
    await fs.rm(path.join(tmpHome, ".claude"), { recursive: true, force: true });
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");

    const sessions = await scanAllSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual([CODEX_SESSION_ID]);
  });

  it("survives an adapter whose discovery throws", async () => {
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const adapters = await import("@/lib/adapters");
    const codexAdapter = adapters.getEnabledAdapters(
      { enabledAdapters: ["claude", "codex"] } as never
    ).find((a) => a.id === "codex")!;
    const original = codexAdapter.discover;
    codexAdapter.discover = async () => {
      throw new Error("codex home exploded");
    };
    try {
      const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
      const sessions = await scanAllSessions();
      // The Claude corpus is untouched: one harness failing must not empty the
      // list for the others.
      expect(sessions.some((s) => s.sessionId === CLAUDE_SESSION_ID)).toBe(true);
      expect(sessions.some((s) => s.sessionId === CODEX_SESSION_ID)).toBe(false);
    } finally {
      codexAdapter.discover = original;
    }
  });

  it("reprices an adapter session from live pricing on a cache hit", async () => {
    // #494's defect, on the path #489 adds. The scan cache is keyed on
    // mtime+size, so a cost baked into the cached summary would survive a
    // pricing-rule change — and an adapter session reaches that cache by a
    // different route than a Claude one, so the re-derivation has to cover both.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const { setPricingRules } = await import("@/lib/usage/costCalculator");

    setPricingRules([
      { pattern: "gpt-4o", inputUsdPerMillion: 1000, outputUsdPerMillion: 1000 },
    ]);
    const first = (await scanAllSessions()).find((s) => s.sessionId === CODEX_SESSION_ID);
    expect(first!.costEstimate).toBeGreaterThan(0);

    setPricingRules([
      { pattern: "gpt-4o", inputUsdPerMillion: 4000, outputUsdPerMillion: 4000 },
    ]);
    const second = (await scanAllSessions()).find((s) => s.sessionId === CODEX_SESSION_ID);
    expect(second!.costEstimate).toBeGreaterThan(first!.costEstimate);

    setPricingRules([]);
  });

  it.skipIf(!driverAvailable)(
    "agrees with the DB backend field by field for the same adapter session",
    async () => {
    // The deliverable. `buildAdapterParsedSession` is shared between ingest and
    // the scanner, but the `ParsedSession` -> `SessionSummary` mapping is not —
    // it mirrors `loadSessionsListFromDb`'s by hand. Agreement by inspection is
    // the failure class #483 was, so it is held here by assertion instead: the
    // same fixture goes through both loaders and the summaries are compared.
    await writeCodexSession();
    await writeConfigFile(["claude", "codex"]);
    process.env.MINDER_USE_DB = "1";
    await state.reload();

    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    const fileSide = (await scanAllSessions()).find(
      (s) => s.sessionId === CODEX_SESSION_ID
    )!;
    expect(fileSide).toBeDefined();

    const mig = await import("@/lib/db/migrations");
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    const conn = await import("@/lib/db/connection");
    const db = (await conn.getDb())!;
    const { reconcileAllSessions } = await import("@/lib/db/ingest");
    assertReconcileClean(await reconcileAllSessions(db));
    const { loadSessionsListFromDb } = await import("@/lib/data/sessionsListFromDb");
    const dbSide = loadSessionsListFromDb(db).find(
      (s) => s.sessionId === CODEX_SESSION_ID
    )!;
    // If this is undefined the ingest side never saw the fixture, and an
    // `toEqual` against `undefined` would report as a field mismatch rather
    // than as "the premise did not hold".
    expect(dbSide).toBeDefined();

    // Excluded, with a reason for each rather than a blanket allowance:
    //   costEstimate   — the DB stores it at ingest, file-parse reprices live
    //                    (#494). A pre-existing, deliberate difference that is
    //                    not specific to adapters.
    //   isActive       — a clock reading taken at two different instants.
    //   treeDelegation / continuedFromSessionId — DB-only, derived by passes
    //                    the file backend does not run.
    //   searchableText — assembled from different-length previews on each side.
    const compare = (s: SessionSummary) => ({
      sessionId: s.sessionId,
      source: s.source,
      projectSlug: s.projectSlug,
      projectName: s.projectName,
      projectPath: s.projectPath,
      startTime: s.startTime,
      endTime: s.endTime,
      durationMs: s.durationMs,
      initialPrompt: s.initialPrompt,
      lastPrompt: s.lastPrompt,
      messageCount: s.messageCount,
      userMessageCount: s.userMessageCount,
      assistantMessageCount: s.assistantMessageCount,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreateTokens: s.cacheCreateTokens,
      toolUsage: s.toolUsage,
      modelsUsed: s.modelsUsed,
      subagentCount: s.subagentCount,
      errorCount: s.errorCount,
      status: s.status,
      skillsUsed: s.skillsUsed,
      oneShotRate: s.oneShotRate,
      cacheHitRatio: s.cacheHitRatio,
      workMode: s.workMode,
    });

    expect(compare(fileSide)).toEqual(compare(dbSide));
    conn.closeDb();
    }
  );
});
