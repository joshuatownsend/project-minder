/**
 * SQL-backed file edits for Hot Files / File Coupling (#439).
 *
 * Both routes used to run `parseAllSessions()` — a full JSONL parse of every
 * session in the portfolio — and then filter to the one project being viewed,
 * so cost scaled with total history rather than with the project. Measured
 * cold on a real index: 190 s for hot-files and 299 s for file-coupling,
 * against payloads of 9 KB and 16 KB.
 *
 * Two things these tests exist to hold:
 *
 * 1. **Parity.** The DB loader must produce the same edits the file path
 *    extracts, or the panels quietly show different numbers depending on a
 *    backend the user never chose.
 * 2. **The invariant the fast query rests on.** The loader deliberately does
 *    NOT join `turns` (an 11.6 s → 295 ms difference), which means it cannot
 *    filter on `role`/`is_sidechain` in SQL. It is safe only because ingest
 *    writes tool uses for assistant, non-sidechain turns exclusively. That is
 *    a property of ingest, not a database constraint, so it is asserted here —
 *    if ingest ever changes, this fails instead of the panels silently gaining
 *    rows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { installIsolatedState } from "./_helpers/isolatedState";

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-fileactivity-db-" });
let tmpHome: string;

beforeEach(() => {
  tmpHome = state.tmpHome();
});

async function writeJsonl(filePath: string, entries: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(ts: string, text: string) {
  return { type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

/** Assistant turn issuing file tools. `ops` is [toolName, file_path] pairs. */
function assistantWithFileOps(ts: string, ops: Array<[string, string]>) {
  return {
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "editing" },
        ...ops.map(([name, file_path], i) => ({
          type: "tool_use",
          id: `tu-${ts}-${i}`,
          name,
          input: { file_path },
        })),
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

async function reload() {
  await state.reload();
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    fromDb: await import("@/lib/data/fileActivityFromDb"),
    parser: await import("@/lib/usage/parser"),
    fileActivity: await import("@/lib/usage/fileActivity"),
    projectMatch: await import("@/lib/usage/projectMatch"),
  };
}

describe.skipIf(!driverAvailable)("loadProjectFileEditsFromDb (#439)", () => {
  async function setup() {
    const reloaded = await reload();
    await reloaded.mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");

    // Two projects, so the scoping is actually exercised: a loader that
    // ignored the project filter would still pass a single-project fixture.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "s1.jsonl"), [
      userTurn("2026-05-01T10:00:00Z", "go"),
      assistantWithFileOps("2026-05-01T10:00:01Z", [
        ["Write", "C:\\dev\\app\\src\\a.ts"],
        ["Edit", "C:\\dev\\app\\src\\b.ts"],
        // Read is a file op but NOT write-class — must be excluded.
        ["Read", "C:\\dev\\app\\src\\c.ts"],
      ]),
      assistantWithFileOps("2026-05-01T10:00:02Z", [["Edit", "C:\\dev\\app\\src\\a.ts"]]),
    ]);
    await writeJsonl(path.join(projectsDir, "C--dev-other", "s2.jsonl"), [
      userTurn("2026-05-01T11:00:00Z", "go"),
      assistantWithFileOps("2026-05-01T11:00:01Z", [["Write", "C:\\dev\\other\\z.ts"]]),
    ]);

    return { ...reloaded, projectsDir };
  }

  it("counts every tool_use block when a message spans several JSONL lines", async () => {
    // Claude Code writes ONE JSONL LINE PER CONTENT BLOCK, all sharing a
    // `message.id`. The DB path counts them all; the file path drops every
    // block after the first, because `parser.ts:231` skips the whole repeated
    // line (the #426 defect, fixed in ingest and still live in the file path —
    // filed as #453).
    //
    // Measured on the real index for one project: 4,164 write edits from raw
    // JSONL, 4,164 in the DB, 1,651 from the file parse. The file path reports
    // 40% of the truth.
    //
    // This test therefore does NOT assert parity — the two genuinely disagree
    // here, and asserting equality would pin the bug. It asserts the DB path
    // is right, which is what makes the ~2.5x jump in these panels a
    // correction rather than a regression.
    const reloaded = await reload();
    await reloaded.mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    const { conn, ingest, fromDb } = reloaded;

    const shared = "msg-multi-block";
    const line = (i: number, file: string) => ({
      type: "assistant",
      timestamp: `2026-05-02T10:00:0${i}Z`,
      message: {
        id: shared, // same id on every line — the multi-block encoding
        model: "claude-sonnet-4-5",
        content: [{ type: "tool_use", id: `tu-multi-${i}`, name: "Edit", input: { file_path: file } }],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10, output_tokens: 5,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        },
      },
    });
    await writeJsonl(path.join(projectsDir, "C--dev-multi", "m1.jsonl"), [
      userTurn("2026-05-02T10:00:00Z", "go"),
      line(1, "C:\\dev\\multi\\one.ts"),
      line(2, "C:\\dev\\multi\\two.ts"),
      line(3, "C:\\dev\\multi\\three.ts"),
    ]);

    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const edits = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "multi",
      projectPath: "C:\\dev\\multi",
    });

    expect(edits).not.toBeNull();

    if (!edits) throw new Error("unreachable");
    expect(edits.map((e) => e.filePath).sort()).toEqual([
      "C:\\dev\\multi\\one.ts",
      "C:\\dev\\multi\\three.ts",
      "C:\\dev\\multi\\two.ts",
    ]);
    conn.closeDb();
  });

  it("matches the file backend's edits exactly", async () => {
    // NOTE: this fixture uses one content block per JSONL line, which is where
    // the two backends agree. They diverge on multi-block messages — see the
    // test above and #453. Parity here means "same extraction rule", not "same
    // answer on every corpus".
    const { conn, ingest, fromDb, parser, fileActivity, projectMatch, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const dbEdits = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "app",
      projectPath: "C:\\dev\\app",
    });

    expect(dbEdits).not.toBeNull();

    if (!dbEdits) throw new Error("unreachable");

    const sessionMap = await parser.parseAllSessions();
    const turns = projectMatch.gatherProjectTurns(sessionMap, "app", "C:\\dev\\app", [], []);
    const fileEdits = fileActivity.extractWriteEdits(turns);

    // Precondition — an empty fixture would make the comparison vacuous, which
    // is the exact shape of the bug in the sibling issue (#450).
    expect(fileEdits.length).toBeGreaterThan(0);

    // `turnIndex` is deliberately excluded: the file path numbers turns by
    // position in its own flattened array, the DB path carries the real
    // transcript index. Neither consumer reads it (buildHotFiles ignores it,
    // buildFileCoupling groups by sessionId), so they are equivalent for these
    // routes — but comparing it would assert an equality that was never true.
    const shape = (e: { sessionId: string; filePath: string; op: string; timestamp: string }) =>
      `${e.sessionId}|${e.filePath}|${e.op}|${e.timestamp}`;
    expect(dbEdits.map(shape).sort()).toEqual(fileEdits.map(shape).sort());
    conn.closeDb();
  });

  it("excludes read-class ops, keeping only writes", async () => {
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const edits = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "app",
      projectPath: "C:\\dev\\app",
    });

    expect(edits).not.toBeNull();

    if (!edits) throw new Error("unreachable");
    expect(edits.every((e) => e.op !== "read")).toBe(true);
    expect(edits.some((e) => e.filePath.endsWith("c.ts"))).toBe(false);
    expect(edits.length).toBe(3); // Write a, Edit b, Edit a
    conn.closeDb();
  });

  it("scopes to the requested project", async () => {
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const edits = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "app",
      projectPath: "C:\\dev\\app",
    });

    expect(edits).not.toBeNull();

    if (!edits) throw new Error("unreachable");
    expect(edits.every((e) => !e.filePath.includes("other"))).toBe(true);

    const none = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "nonexistent",
      projectPath: "C:\\dev\\nonexistent",
    });
    expect(none).toEqual([]);
    conn.closeDb();
  });

  it("returns null when a transcript has never been ingested", async () => {
    // Ingest lag. `getReadyDb()` succeeding says the DB opens, not that it has
    // caught up — and the routes cache whatever they get for five minutes, so
    // handing back a partial answer would show an empty Hot Files panel for a
    // project with real edits on disk (Codex, PR #454).
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    // Sanity: fresh index serves the project.
    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "app", projectPath: "C:\\dev\\app" })
    ).not.toBeNull();

    // A new session lands on disk and is NOT ingested — the cold-start and
    // just-finished-a-session cases.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "s-new.jsonl"), [
      userTurn("2026-05-01T12:00:00Z", "go"),
      assistantWithFileOps("2026-05-01T12:00:01Z", [["Write", "C:\\dev\\app\\src\\new.ts"]]),
    ]);

    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "app", projectPath: "C:\\dev\\app" })
    ).toBeNull();

    // ...and once ingest catches up, the fast path resumes.
    await ingest.reconcileAllSessions(db, { projectsDir });
    const after = fromDb.loadProjectFileEditsFromDb(db, {
      slug: "app",
      projectPath: "C:\\dev\\app",
    });
    expect(after).not.toBeNull();
    expect(after!.some((e) => e.filePath.endsWith("new.ts"))).toBe(true);
    conn.closeDb();
  });

  it("is NOT marked stale by an un-ingested transcript in a DIFFERENT project", async () => {
    // The freshness check originally ran over every row in `sessions`, so one
    // un-ingested transcript anywhere in the portfolio marked EVERY project
    // stale — near-permanent on an active machine, and it would have quietly
    // returned both routes to the 77-190s parse this change exists to remove.
    // Copilot and Codex reported it independently (PR #454).
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    // A brand-new, un-ingested session in the OTHER project.
    await writeJsonl(path.join(projectsDir, "C--dev-other", "s-other-new.jsonl"), [
      userTurn("2026-05-01T13:00:00Z", "go"),
      assistantWithFileOps("2026-05-01T13:00:01Z", [["Write", "C:\\dev\\other\\new.ts"]]),
    ]);

    // `app` is untouched, so it must still be served from the index...
    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "app", projectPath: "C:\\dev\\app" })
    ).not.toBeNull();
    // ...while `other` — the project that actually has an un-ingested file —
    // correctly falls back.
    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "other", projectPath: "C:\\dev\\other" })
    ).toBeNull();
    conn.closeDb();
  });

  it("returns null when a known transcript has grown since it was ingested", async () => {
    // The second staleness axis: not a new file, but an ongoing session whose
    // transcript has been appended to since ingest recorded its mtime.
    const { conn, ingest, fromDb, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });
    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "app", projectPath: "C:\\dev\\app" })
    ).not.toBeNull();

    const target = path.join(projectsDir, "C--dev-app", "s1.jsonl");
    const existing = await fs.readFile(target, "utf8");
    await fs.writeFile(
      target,
      existing +
        JSON.stringify(
          assistantWithFileOps("2026-05-01T10:00:03Z", [["Write", "C:\\dev\\app\\src\\d.ts"]])
        ) +
        "\n"
    );
    // Push the mtime unambiguously past the recorded one — the check floors
    // both sides to whole milliseconds, and a same-tick rewrite would not be
    // staleness.
    const future = new Date(Date.now() + 5000);
    await fs.utimes(target, future, future);

    expect(
      fromDb.loadProjectFileEditsFromDb(db, { slug: "app", projectPath: "C:\\dev\\app" })
    ).toBeNull();
    conn.closeDb();
  });

  it("INVARIANT: ingest writes tool_uses only for assistant, non-sidechain turns", async () => {
    // The load-bearing assumption behind dropping the `turns` join (11.6 s ->
    // 295 ms). The loader cannot filter on role or is_sidechain without that
    // join, so it relies on ingest never producing such a row.
    //
    // Measured on the real index: 0 of 78,212. This pins it against a fixture
    // so an ingest change fails HERE — loudly and in one place — instead of
    // quietly adding rows to two dashboards.
    const { conn, ingest, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const offenders = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM tool_uses tu
           JOIN turns t USING (session_id, turn_index)
          WHERE t.role <> 'assistant' OR t.is_sidechain <> 0`
      )
      .get() as { c: number };
    expect(offenders.c).toBe(0);
    conn.closeDb();
  });

  it("INVARIANT: tool_uses.ts is populated and agrees with turns.ts", async () => {
    // The other half of dropping the join: the loader reads `tu.ts` for each
    // edit's timestamp instead of `turns.ts`. Measured 0 NULLs and 0
    // disagreements across 78,212 real rows; pinned here so an ingest change
    // that stopped stamping it cannot silently produce edits with no time.
    const { conn, ingest, projectsDir } = await setup();
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const bad = db
      .prepare(
        `SELECT
           SUM(CASE WHEN tu.ts IS NULL THEN 1 ELSE 0 END) AS nulls,
           SUM(CASE WHEN tu.ts IS NOT NULL AND tu.ts <> t.ts THEN 1 ELSE 0 END) AS mismatches
         FROM tool_uses tu
         JOIN turns t USING (session_id, turn_index)`
      )
      .get() as { nulls: number | null; mismatches: number | null };
    expect(bad.nulls ?? 0).toBe(0);
    expect(bad.mismatches ?? 0).toBe(0);
    conn.closeDb();
  });
});
