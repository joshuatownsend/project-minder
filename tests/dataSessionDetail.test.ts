import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// Parity test for `getSessionDetail`. Drives the same fixture through
// both backends (file-parse via `scanSessionDetail`, DB via
// `loadSessionDetailFromDb`) and asserts agreement on every field that
// isn't an intentional divergence.
//
// Documented divergences (from header comment in
// `src/lib/data/sessionDetailFromDb.ts`):
// 1. `recaps` undefined in DB path
// 2. `searchableText` undefined in DB path
// 3. `subagents.messageCount` undefined (not 0) and `toolUsage` empty in DB path
// 4. `status` heuristic (working/idle from age) in DB path
// 5. `bash` fileOperations from `tool_uses` not `file_edits`
// 6. No `thinking` events; at most one `assistant` event per turn
// 7. Sidechain entries skipped at ingest
// 8. fileOperations limited to Read/Write/Edit/Glob/Grep + Bash
//
// **Fixture constraint**: every assistant turn in `setupFixture` has at
// most one text block and no `thinking` blocks, no sidechain entries,
// and no MultiEdit/NotebookEdit calls. That keeps the parity assertions
// (`timeline.length`, event-type sequence, `fileOperations` set) true
// despite divergences (6)–(8). Adding a multi-block/thinking/sidechain
// case to the fixture would intentionally break those asserts and
// require relaxing them to "DB events are a subsequence of file events"
// — out of scope until ingest persists content blocks.
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

const state = installIsolatedState({ prefix: "pm-data-detail-", extraGlobals: ["__usageCache", "__usageFileCache", "__sessionIndex"], preserveEnv: ["MINDER_USE_DB"] });

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
  toolCalls: Array<{ id?: string; name: string; input: unknown }> = []
): JsonlEntry {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of toolCalls) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return {
    type: "assistant",
    timestamp,
    message: {
      model,
      content,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

const SESSION_ID = "abcdef00-1111-2222-3333-444455556666";

async function setupFixture(): Promise<string> {
  const projectsDir = path.join(tmpHome, ".claude", "projects");
  await writeJsonl(path.join(projectsDir, "C--dev-app-x", `${SESSION_ID}.jsonl`), [
    userTurn("2026-04-15T10:00:00Z", "fix the bug in the parser"),
    assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "Looking at it", [
      { id: "tu_a1", name: "Read", input: { file_path: "/repo/parser.ts" } },
    ]),
    assistantTurn("2026-04-15T10:00:02Z", "claude-sonnet-4-5", "Fixing now", [
      { id: "tu_a2", name: "Edit", input: { file_path: "/repo/parser.ts", old_string: "x", new_string: "y" } },
      { id: "tu_a3", name: "Bash", input: { command: "npm test" } },
    ]),
    assistantTurn("2026-04-15T10:00:03Z", "claude-sonnet-4-5", "Dispatching agent", [
      {
        id: "tu_a4",
        name: "Agent",
        input: { subagent_type: "Explore", description: "scope the bug", prompt: "find the bug" },
      },
    ]),
    userTurn("2026-04-15T10:00:30Z", "looks good"),
  ]);
  return projectsDir;
}

async function reloadModules() {
  await state.reload();
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

describe.skipIf(!driverAvailable)("data façade — getSessionDetail backend parity", () => {
  it("file backend serves when MINDER_USE_DB=0 and returns a populated SessionDetail", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "0";
    const { facade } = await reloadModules();
    const result = await facade.getSessionDetail(SESSION_ID);

    expect(result.meta.backend).toBe("file");
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
    expect(result.detail!.userMessageCount).toBe(2);
    expect(result.detail!.assistantMessageCount).toBe(3);
    // Timeline includes 2 user + 3 assistant text + 4 tool_use blocks = 9 events.
    // (User turns with non-empty text are kept; tool-result-only user turns are skipped.)
    expect(result.detail!.timeline.length).toBeGreaterThanOrEqual(8);
    expect(result.detail!.subagents.length).toBe(1);
    expect(result.detail!.subagents[0].type).toBe("Explore");
    // No .meta.json files in fixture — metaSourced must be false on both paths.
    expect(result.detail!.subagents[0].metaSourced).toBe(false);
  });

  it("falls back to file-parse when the session isn't indexed", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade } = await reloadModules();
    // No reconcile → DB has no rows for this session → DB path returns null
    // → façade falls through to file-parse, which finds the JSONL on disk.
    // The HTTP layer would only return 404 if BOTH backends miss; this test
    // proves the DB miss alone doesn't 404.
    const result = await facade.getSessionDetail(SESSION_ID);
    expect(result.meta.backend).toBe("file");
    expect(result.detail).not.toBeNull();
  });

  it("DB backend serves the same SessionDetail (modulo documented divergences)", async () => {
    const projectsDir = await setupFixture();

    // -- File-parse run --
    process.env.MINDER_USE_DB = "0";
    const { facade: fileFacade } = await reloadModules();
    const fileResult = await fileFacade.getSessionDetail(SESSION_ID);
    expect(fileResult.meta.backend).toBe("file");
    expect(fileResult.detail).not.toBeNull();

    // -- DB run --
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
    const dbResult = await dbFacade.getSessionDetail(SESSION_ID);
    expect(dbResult.meta.backend).toBe("db");
    expect(dbResult.detail).not.toBeNull();

    const f = fileResult.detail!;
    const d = dbResult.detail!;

    // Numeric fields must match exactly.
    expect(d.sessionId).toBe(f.sessionId);
    expect(d.projectSlug).toBe(f.projectSlug);
    expect(d.projectName).toBe(f.projectName);
    expect(d.projectPath).toBe(f.projectPath);
    expect(d.startTime).toBe(f.startTime);
    expect(d.endTime).toBe(f.endTime);
    expect(d.durationMs).toBe(f.durationMs);
    expect(d.initialPrompt).toBe(f.initialPrompt);
    // file-parse computes lastPrompt with same suppression logic; both
    // backends suppress when equal to initialPrompt.
    expect(d.lastPrompt).toBe(f.lastPrompt);
    expect(d.messageCount).toBe(f.messageCount);
    expect(d.userMessageCount).toBe(f.userMessageCount);
    expect(d.assistantMessageCount).toBe(f.assistantMessageCount);
    expect(d.inputTokens).toBe(f.inputTokens);
    expect(d.outputTokens).toBe(f.outputTokens);
    expect(d.cacheReadTokens).toBe(f.cacheReadTokens);
    expect(d.cacheCreateTokens).toBe(f.cacheCreateTokens);
    expect(d.costEstimate).toBeCloseTo(f.costEstimate, 6);
    expect(d.errorCount).toBe(f.errorCount);
    expect(d.subagentCount).toBe(f.subagentCount);
    expect(d.modelsUsed.sort()).toEqual([...f.modelsUsed].sort());
    expect(d.toolUsage).toEqual(f.toolUsage);
    expect(d.skillsUsed).toEqual(f.skillsUsed);
    expect(d.gitBranch).toBe(f.gitBranch);
    expect(d.isActive).toBe(f.isActive);

    // Timeline: same length and same event-type sequence.
    expect(d.timeline.length).toBe(f.timeline.length);
    for (let i = 0; i < f.timeline.length; i++) {
      expect(d.timeline[i].type, `timeline[${i}].type`).toBe(f.timeline[i].type);
      expect(d.timeline[i].toolName, `timeline[${i}].toolName`).toBe(f.timeline[i].toolName);
    }

    // File operations: every (path, operation) pair from file-parse must
    // be present in DB output. Order can differ because file-parse
    // emits in JSONL order; DB emits file_edits first then bash entries.
    const fileOpKey = (op: { path: string; operation: string }) => `${op.operation}:${op.path}`;
    const fileSet = new Set(f.fileOperations.map(fileOpKey));
    const dbSet = new Set(d.fileOperations.map(fileOpKey));
    expect(dbSet).toEqual(fileSet);

    // Subagents: count matches; per-agent type/description preserved.
    // messageCount and toolUsage are zeroed in DB path (documented).
    expect(d.subagents.length).toBe(f.subagents.length);
    const fByType = new Map(f.subagents.map((s) => [s.type, s]));
    for (const dSub of d.subagents) {
      const fSub = fByType.get(dSub.type);
      expect(fSub, `subagent type ${dSub.type} missing in file path`).toBeDefined();
      expect(dSub.description).toBe(fSub!.description);
      // No .meta.json files in test fixture — both paths produce same meta fields.
      expect(dSub.metaSourced).toBe(fSub!.metaSourced);
      expect(dSub.category).toBe(fSub!.category);
      // Documented divergence. `messageCount` is **undefined, not 0**: the DB
      // path cannot count sidechain turns, and reporting 0 made that
      // indistinguishable from a subagent that genuinely took none — a
      // consumer comparing it with Claude Code's own `metaTurnCount` read the
      // backend limitation as a data disagreement (#403). `toolUsage` stays an
      // empty object because "no tools recorded" and "cannot record tools"
      // both render as no chips; only the count was ever compared.
      expect(dSub.messageCount).toBeUndefined();
      expect(dSub.toolUsage).toEqual({});
    }

    // Documented divergences — assert the DB path's intentional differences.
    expect(d.recaps).toBeUndefined();
    expect(d.searchableText).toBeUndefined();

    // Issue #172 — parity with the list loader on three previously-missing
    // SessionSummary fields. The fixture's project dir is non-worktree,
    // adapter source defaults to "claude" at reconcile time, and the
    // workmode aggregator either fills all four columns or none — so
    // both backends should agree on each field even for the default
    // fixture shape.
    expect(d.isWorktree).toBe(f.isWorktree);
    expect(d.source).toBe(f.source);
    expect(d.workMode).toEqual(f.workMode);
  });

  it("DB loader populates isWorktree / source / workMode (issue #172 parity)", async () => {
    // Drives values that the default reconcile path wouldn't produce:
    //   - project dir name carrying the worktree separator
    //   - non-"claude" adapter `source` column
    //   - all four work_mode_*_pct columns set
    // Then asserts the detail loader propagates each to SessionDetail.
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const worktreeDir = "C--dev-app-x--claude-worktrees-feature";
    await writeJsonl(path.join(projectsDir, worktreeDir, `${SESSION_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "hello", []),
    ]);

    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    const db = (await conn.getDb())!;
    assertReconcileClean(await ingest.reconcileAllSessions(db, { projectsDir }));

    // Stamp non-default values that reconcile doesn't naturally produce.
    db.prepare(
      `UPDATE sessions
         SET source = ?,
             work_mode_exploration_pct = ?,
             work_mode_building_pct = ?,
             work_mode_testing_pct = ?,
             work_mode_other_pct = ?
       WHERE session_id = ?`
    ).run("codex", 40, 30, 20, 10, SESSION_ID);

    const result = await facade.getSessionDetail(SESSION_ID);
    expect(result.meta.backend).toBe("db");
    expect(result.detail).not.toBeNull();
    const d = result.detail!;
    expect(d.isWorktree).toBe(true);
    expect(d.source).toBe("codex");
    expect(d.workMode).toEqual({
      exploration: 40,
      building: 30,
      testing: 20,
      other: 10,
    });
  });

  it("opens an agent-* subagent session rather than 404ing on its id (#483)", async () => {
    // The regression #483 records, end to end through the facade.
    //
    // Newer Claude Code writes subagent transcripts to
    // `<project>/<session>/subagents/agent-*.jsonl`, and ingest walks them —
    // so `loadSessionsListFromDb`, whose only predicate is `turn_count > 0`,
    // LISTS them. Every detail loader then rejected the id at a
    // `/^[a-f0-9-]+$/i` gate, because `g`/`n`/`t` are not hex. Measured on a
    // real index: 1,268 of 6,656 sessions (19%) listed and unopenable, on both
    // backends.
    const projectsDir = await setupFixture();
    const AGENT_ID = "agent-a38db58938dbeea68";
    await writeJsonl(
      path.join(projectsDir, "C--dev-app-x", SESSION_ID, "subagents", `${AGENT_ID}.jsonl`),
      [
        userTurn("2026-04-15T10:00:10Z", "scope the bug"),
        assistantTurn("2026-04-15T10:00:11Z", "claude-sonnet-4-5", "Found it", [
          { id: "tu_s1", name: "Read", input: { file_path: "/repo/parser.ts" } },
        ]),
      ]
    );

    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        recordRun: "reconcile",
      })
    );

    // Premise guard: without this the assertion below could pass because the
    // session was never indexed, which is a different (and silent) failure.
    const db = (await conn.getDb())!;
    const row = db
      .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
      .get(AGENT_ID) as { session_id: string } | undefined;
    expect(row?.session_id).toBe(AGENT_ID);

    const result = await facade.getSessionDetail(AGENT_ID);
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(AGENT_ID);
  });

  it("rejects path-traversal-shaped sessionIds", async () => {
    await setupFixture();
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );

    const result = await facade.getSessionDetail("../../../etc/passwd");
    expect(result.detail).toBeNull();
  });

  // ── Slug + sessionId disambiguation (PR #60 review fix) ────────────────
  //
  // The shape gate must be hex-and-dash, not strict UUID. A non-canonical
  // hex sessionId (anything matching `[a-f0-9-]+` that isn't UUID-shaped)
  // would otherwise route through slug resolution and miss the loader.

  it("DB-resolves a session by its human-readable slug", async () => {
    const SLUG = "shimmering-quokka-prancing";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${SESSION_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      // Slug appears as a top-level field on assistant entries.
      {
        type: "assistant",
        timestamp: "2026-04-15T10:00:01Z",
        slug: SLUG,
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as any,
    ]);
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );

    const result = await facade.getSessionDetail(SLUG);
    expect(result.meta.backend).toBe("db");
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
  });

  it("resolves an agent-prefixed SLUG rather than reading it as an id (#484)", async () => {
    // The collision Copilot found. `agent-cafe-deed` matches the id shape test
    // — `agent-` prefix, hex-and-dash remainder — so once #483 admitted that
    // prefix, a session carrying this slug started 404ing: shape said "id",
    // slug resolution never ran, and no session has that id.
    //
    // Fixed by asking the index BEFORE falling back to shape. Shape cannot
    // separate these two spaces at all, and tightening the pattern would only
    // move the boundary, so the test pins the lookup order rather than a regex.
    const SLUG = "agent-cafe-deed";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${SESSION_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      {
        type: "assistant",
        timestamp: "2026-04-15T10:00:01Z",
        slug: SLUG,
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as any,
    ]);
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        recordRun: "reconcile",
      })
    );

    const result = await facade.getSessionDetail(SLUG);
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
  });

  it("an exact session id wins over another session's identical slug (#484)", async () => {
    // Nothing enforces that a slug cannot equal some other session's id — the
    // schema has no cross-column uniqueness constraint, and a hex-shaped slug
    // is the long-documented `cafe-faded-deed` case. So when slug was probed
    // first, `/sessions/<sessionId>` could silently open a DIFFERENT session:
    // a wrong answer rather than a missing one, which is the worse failure.
    //
    // Pins the lookup ORDER (id, then slug, then shape) rather than any regex.
    const OTHER_ID = "11112222-3333-4444-5555-666677778888";
    const projectsDir = path.join(tmpHome, ".claude", "projects");

    // Session A: the one actually being asked for, keyed by its id.
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${SESSION_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "the session we want"),
      assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "A", []),
    ]);
    // Session B: a decoy carrying A's id as its SLUG.
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${OTHER_ID}.jsonl`), [
      userTurn("2026-04-15T11:00:00Z", "the decoy"),
      {
        type: "assistant",
        timestamp: "2026-04-15T11:00:01Z",
        slug: SESSION_ID,
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "B" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
    ]);

    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, { projectsDir, recordRun: "reconcile" })
    );

    // Premise guard: the decoy must really carry that slug, or this asserts
    // nothing — the id would win by default rather than by the fix.
    const db = (await conn.getDb())!;
    const decoy = db
      .prepare("SELECT session_id FROM sessions WHERE slug = ?")
      .get(SESSION_ID) as { session_id: string } | undefined;
    expect(decoy?.session_id).toBe(OTHER_ID);

    const result = await facade.getSessionDetail(SESSION_ID);
    expect(result.detail).not.toBeNull();
    expect(result.detail!.sessionId).toBe(SESSION_ID);
  });

  it("non-canonical hex sessionIds still hit the DB loader (not slug resolution)", async () => {
    // 32-char hex without UUID dashes — valid for the loader's hex gate
    // but rejected by a strict UUID regex. Pre-PR-60-fix this would have
    // tried slug resolution (miss), then file-parse with the hex string
    // (which would resolve, but via the slow path). The loader must be
    // hit directly.
    const HEX_ID = "abcdef00111122223333444455556666";
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    await writeJsonl(path.join(projectsDir, "C--dev-app", `${HEX_ID}.jsonl`), [
      userTurn("2026-04-15T10:00:00Z", "hi"),
      assistantTurn("2026-04-15T10:00:01Z", "claude-sonnet-4-5", "hello", []),
    ]);
    process.env.MINDER_USE_DB = "1";
    const { facade, conn, mig, ingest } = await reloadModules();
    await mig.initDb();
    assertReconcileClean(
      await ingest.reconcileAllSessions((await conn.getDb())!, {
        projectsDir,
        // Mirrors production's initial pass, which records itself so the index
        // can prove it has been read through. Without it the #472 gates read
        // this seeded DB as "still building" and serve file-parse.
        recordRun: "reconcile",
      })
    );

    const result = await facade.getSessionDetail(HEX_ID);
    expect(result.meta.backend).toBe("db");
    expect(result.detail!.sessionId).toBe(HEX_ID);
  });
});
