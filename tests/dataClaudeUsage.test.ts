import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// Parity test for `getClaudeUsage`. Drives the same fixture through
// both backends (file-parse via `scanClaudeConversationsForProjects`,
// DB via `loadClaudeUsageStatsFromDb`) and asserts agreement on every
// numeric field except `costEstimate` — which is documented as more
// accurate under DB mode (file-parse buckets cache-only files as
// "unknown" → sonnet-fallback pricing; DB knows the actual model).
//
// **Fixture constraint**: assistant turns specify a real model and
// have non-zero token usage so per-model cost calculation has data
// to chew on.
//
// The fixture deliberately includes a **nested subagent transcript**
// (`<project>/<parent>/subagents/agent-*.jsonl`, sidechain-flagged,
// carrying its own model and its own tool call). Without it this file
// is blind to the entire class of divergence #480 was about: ingest
// indexes those files, file-parse never sees them, and the fixture
// that omits them ratifies whatever the backends happen to do. That is
// the same trap PR #484's end-to-end test fell into — a fixture that
// left out the marker every real transcript carries.
//
// What it pins, beyond parity:
//   - `conversationCount` counts only real conversations (was 3 vs 2)
//   - the nested `Grep` call does NOT reach `toolUsage`
//   - the nested `claude-haiku-4-5` model does NOT reach `modelsUsed`
//   - the nested turn's tokens reach NEITHER backend's totals here
//     (ingest's session-row aggregates are primary-only)
// Every one of those is only pinned while the nested entries exist.
//
// Skipped when better-sqlite3 isn't loadable.

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-data-claude-", extraGlobals: ["__usageCache", "__usageFileCache", "__sessionIndex", "__sessionsCache", "__claudeUsageCache"], preserveEnv: ["MINDER_USE_DB"] });

/** Mirror of the helper's temp home, so fixture paths below read unchanged. */
let tmpHome: string;

interface JsonlEntry {
  type: "user" | "assistant" | "system";
  timestamp: string;
  message?: any;
  content?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(timestamp: string, text: string): JsonlEntry {
  return {
    type: "user",
    timestamp,
    message: { content: [{ type: "text", text }] },
  };
}

function assistantTurn(
  timestamp: string,
  model: string,
  text: string,
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = [],
  isSidechain = false
): JsonlEntry {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return {
    type: "assistant",
    timestamp,
    ...(isSidechain ? { isSidechain: true } : {}),
    message: {
      model,
      content,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    },
  };
}

const SESSION_A = "aaaaaaaa-4444-4444-4444-444455556666";
const SESSION_B = "bbbbbbbb-4444-4444-4444-444455556666";
const AGENT_SESSION = "agent-cccccccc4444444444445555";

async function setupFixture(): Promise<{ projectsDir: string; projectPaths: string[] }> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_A}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "do task"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Reading", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/x.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Editing", [
      { id: "tu_a2", name: "Edit", input: { file_path: "/repo/x.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);
  await writeJsonl(path.join(projectsDir, "C--dev-app-y", `${SESSION_B}.jsonl`), [
    userTurn("2026-04-16T11:00:00Z", "another"),
    assistantTurn("2026-04-16T11:00:01Z", "claude-sonnet-4-5", "Bash", [
      { id: "tu_b1", name: "Bash", input: { command: "npm test" } },
    ]),
  ]);
  // Nested subagent transcript under session A — see the header note.
  await writeJsonl(
    path.join(projectsDir, "C--dev-app-x", SESSION_A, "subagents", `${AGENT_SESSION}.jsonl`),
    [
      { type: "user", timestamp: "2026-04-15T10:00:03Z", isSidechain: true,
        message: { content: [{ type: "text", text: "subagent prompt" }] } },
      assistantTurn("2026-04-15T10:00:04Z", "claude-haiku-4-5", "Grepping", [
        { id: "tu_s1", name: "Grep", input: { pattern: "foo" } },
      ], true),
    ]
  );
  // Use the decoded form because `encodePath` will re-encode it inside
  // both backends — exactly mirroring the production /api/stats call shape.
  return {
    projectsDir,
    projectPaths: ["C:\\dev\\app-x", "C:\\dev\\app-y"],
  };
}

async function reloadModules() {
  await state.reload();
  delete (globalThis as { __claudeUsageCache?: unknown }).__claudeUsageCache;
  return {
    facade: await import("@/lib/data"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});



describe.skipIf(!driverAvailable)("data façade — getClaudeUsage backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0", async () => {
    const { projectPaths } = await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getClaudeUsage(projectPaths);

    expect(result.meta.backend).toBe("file");
    expect(result.stats.conversationCount).toBe(2);
    expect(result.stats.totalTurns).toBeGreaterThan(0);
    expect(result.stats.modelsUsed).toContain("claude-sonnet-4-5");
    // The nested transcript's model is not this project's.
    expect(result.stats.modelsUsed).not.toContain("claude-haiku-4-5");
  });

  it("falls back to file-parse when no matching sessions are indexed", async () => {
    const { projectPaths } = await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, mig } = await reloadModules();
    await mig.initDb();
    const result = await facade.getClaudeUsage(projectPaths);
    // Empty index → fall through to file-parse; both projects are on disk.
    expect(result.meta.backend).toBe("file");
    expect(result.stats.conversationCount).toBe(2);
  });

  it("DB backend serves the same ClaudeUsageStats (modulo costEstimate accuracy)", async () => {
    const { projectsDir, projectPaths } = await setupFixture();

    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getClaudeUsage(projectPaths);
    expect(fileResult.meta.backend).toBe("file");

    process.env.MINDER_USE_DB = "1";
    const { facade: dbFacade, conn, mig, ingest } = await reloadModules();
    const init = await mig.initDb();
    expect(init.available).toBe(true);
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );
    const dbResult = await dbFacade.getClaudeUsage(projectPaths);
    expect(dbResult.meta.backend).toBe("db");

    const f = fileResult.stats;
    const d = dbResult.stats;

    // Absolute, not just parity: two real conversations exist on disk.
    // Parity alone would still pass if both backends drifted to 3 and
    // started counting the nested transcript.
    expect(f.conversationCount).toBe(2);
    expect(d.conversationCount).toBe(2);
    expect(d.conversationCount).toBe(f.conversationCount);
    expect(d.totalTurns).toBe(f.totalTurns);
    expect(d.inputTokens).toBe(f.inputTokens);
    expect(d.outputTokens).toBe(f.outputTokens);
    expect(d.cacheCreateTokens).toBe(f.cacheCreateTokens);
    expect(d.cacheReadTokens).toBe(f.cacheReadTokens);
    expect(d.totalTokens).toBe(f.totalTokens);
    expect(d.errorCount).toBe(f.errorCount);
    expect(d.toolUsage).toEqual(f.toolUsage);
    expect(d.modelsUsed.sort()).toEqual([...f.modelsUsed].sort());

    // costEstimate: documented divergence — DB more accurate. Both
    // backends should still agree to ~4 decimal places (toBeCloseTo's
    // precision arg) on this fixture because every assistant turn
    // carries an explicit canonical model name (`claude-sonnet-4-5`),
    // so file-parse never falls into its sonnet-fallback branch for
    // cache-only rows. The divergence only kicks in for corpora with
    // non-sonnet models on cache-hit files, which the fixture avoids.
    expect(d.costEstimate).toBeGreaterThan(0);
    expect(d.costEstimate).toBeCloseTo(f.costEstimate, 4);
  });

  it("returns empty stats cleanly when projectPaths is empty", async () => {
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getClaudeUsage([]);
    expect(result.stats.conversationCount).toBe(0);
    expect(result.stats.totalTokens).toBe(0);
    expect(result.meta.backend).toBe("file");
  });
});
