import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { promises as fs } from "fs";
import { aggregateUsage } from "@/lib/usage/aggregator";
import { emptyActivity } from "@/lib/usage/activityBuckets";
import { normalizePathKey } from "@/lib/platform";
import type { UsageTurn } from "@/lib/usage/types";
import type { MinderConfig } from "@/lib/types";
import { installIsolatedState } from "./_helpers/isolatedState";
import { assertReconcileClean } from "./_helpers/reconcile";

// #311 — the Claude-home discriminator for per-project usage/cost reports.
// Two configured homes with identical path layouts (Ubuntu + Debian both
// /home/me/dev/app) produce the SAME projectSlug; these tests prove the
// pipeline keeps their spend separable on both backends:
//   - aggregateUsage groups byProject per (slug, home) and emits `homeKey`
//   - generateUsageReport's `home` param filters turns by their home stamp
//   - DB ingest stamps sessions.home_key; loadUsageReportFromSql filters on it

const HOME_A = "//wsl.localhost/ubuntu/home/me/.claude";
const HOME_B = "//wsl.localhost/debian/home/me/.claude";

function makeTurn(overrides: Partial<UsageTurn> = {}): UsageTurn {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    sessionId: "sess1",
    projectSlug: "-home-me-dev-app",
    projectDirName: "-home-me-dev-app",
    model: "claude-opus-4-7",
    role: "assistant",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    toolCalls: [],
    source: "claude",
    ...overrides,
  };
}

describe("aggregateUsage byProject — (slug, home) composite grouping", () => {
  it("keeps two homes with the same slug as separate rows carrying homeKey", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "a1", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 }),
      makeTurn({ sessionId: "a2", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 }),
      makeTurn({ sessionId: "b1", homeKey: HOME_B, inputTokens: 300, outputTokens: 0 }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());

    expect(report.byProject).toHaveLength(2);
    const rowA = report.byProject.find((r) => r.homeKey === HOME_A);
    const rowB = report.byProject.find((r) => r.homeKey === HOME_B);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.projectSlug).toBe("-home-me-dev-app");
    expect(rowB!.projectSlug).toBe("-home-me-dev-app");
    expect(rowA!.tokens).toBe(200);
    expect(rowB!.tokens).toBe(300);
    expect(rowA!.turns).toBe(2);
    expect(rowB!.turns).toBe(1);
  });

  it("emits a single row without homeKey for unstamped turns (single-home / legacy)", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1" }),
      makeTurn({ sessionId: "s2" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.byProject).toHaveLength(1);
    expect("homeKey" in report.byProject[0]).toBe(false);
    expect(report.byProject[0].turns).toBe(2);
  });

  it("keeps stamped and unstamped turns of one slug as distinct rows", async () => {
    const turns: UsageTurn[] = [
      makeTurn({ sessionId: "s1", homeKey: HOME_A }),
      makeTurn({ sessionId: "s2" }),
    ];
    const report = await aggregateUsage(turns, "all", emptyActivity());
    expect(report.byProject).toHaveLength(2);
  });
});

describe("generateUsageReport — home filter (file backend)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("scopes totals to the requested home's turns only", async () => {
    // Reset the registry FIRST — the static aggregator import at the top of
    // this file already cached it against the real parser; doMock only
    // affects modules imported after a reset.
    vi.resetModules();
    const sessionMap = new Map<string, UsageTurn[]>([
      ["a1", [makeTurn({ sessionId: "a1", homeKey: HOME_A, inputTokens: 100, outputTokens: 0 })]],
      ["b1", [makeTurn({ sessionId: "b1", homeKey: HOME_B, inputTokens: 300, outputTokens: 0 })]],
      // Unstamped turn: strict filtering must exclude it, not guess.
      ["u1", [makeTurn({ sessionId: "u1", inputTokens: 700, outputTokens: 0 })]],
    ]);
    vi.doMock("@/lib/usage/parser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/usage/parser")>()),
      parseAllSessions: vi.fn(async () => sessionMap),
    }));
    const { generateUsageReport } = await import("@/lib/usage/aggregator");

    const filtered = await generateUsageReport("all", "-home-me-dev-app", undefined, HOME_A);
    expect(filtered.totalTokens).toBe(100);
    expect(filtered.totalTurns).toBe(1);

    const unfiltered = await generateUsageReport("all", "-home-me-dev-app");
    expect(unfiltered.totalTokens).toBe(1100);
  });
});

// ── DB backend: ingest stamps home_key; SQL report filters on it ───────────

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

const state = installIsolatedState({ prefix: "pm-usage-home-" });

/** Mirror of the helper's temp home, so fixture paths below read unchanged. */
let tmpHome: string;

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: unknown;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function assistantTurn(timestamp: string, inputTokens: number): JsonlEntry {
  return {
    type: "assistant",
    timestamp,
    message: {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "work" }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

async function reloadModules() {
  await state.reload();
  return {
    fromDb: await import("@/lib/data/usageFromDb"),
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
  };
}

beforeEach(() => {
  tmpHome = state.tmpHome();
});

describe.skipIf(!driverAvailable)("home_key end-to-end: multi-home ingest → SQL report", () => {
  it("stamps each session with its owning home and filters the report on it", async () => {
    // Primary home = <tmp>/.claude (homedir mock); extra home = <tmp>/extra/.claude.
    // Both record a session under the SAME encoded dirname → same project_slug.
    const primaryHome = path.join(tmpHome, ".claude");
    const extraHome = path.join(tmpHome, "extra", ".claude");
    const dirName = "-home-me-dev-app";
    await writeJsonl(path.join(primaryHome, "projects", dirName, "sess-a.jsonl"), [
      assistantTurn("2025-01-01T10:00:00Z", 100),
    ]);
    await writeJsonl(path.join(extraHome, "projects", dirName, "sess-b.jsonl"), [
      assistantTurn("2025-01-02T10:00:00Z", 300),
    ]);

    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;
    const config = { claudeHomes: [extraHome] } as unknown as MinderConfig;
    assertReconcileClean(await mods.ingest.reconcileAllSessions(db, { config }));

    const primaryKey = normalizePathKey(primaryHome);
    const extraKey = normalizePathKey(extraHome);
    const rows = db
      .prepare("SELECT session_id, home_key FROM sessions ORDER BY session_id")
      .all() as Array<{ session_id: string; home_key: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session_id === "sess-a")?.home_key).toBe(primaryKey);
    expect(rows.find((r) => r.session_id === "sess-b")?.home_key).toBe(extraKey);

    // toSlug drops the leading dash of POSIX-encoded dirnames.
    const slug = "home-me-dev-app";
    const all = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    expect(all.totalTokens).toBe(400);
    // One byProject row per (slug, home), each carrying its homeKey.
    expect(all.byProject).toHaveLength(2);
    expect(new Set(all.byProject.map((r) => r.homeKey))).toEqual(
      new Set([primaryKey, extraKey])
    );

    const onlyPrimary = mods.fromDb.loadUsageReportFromSql(db, "all", slug, undefined, primaryKey);
    expect(onlyPrimary.totalTokens).toBe(100);
    expect(onlyPrimary.totalSessions).toBe(1);
    expect(onlyPrimary.byProject).toHaveLength(1);
    expect(onlyPrimary.byProject[0].homeKey).toBe(primaryKey);

    const onlyExtra = mods.fromDb.loadUsageReportFromSql(db, "all", slug, undefined, extraKey);
    expect(onlyExtra.totalTokens).toBe(300);
    expect(onlyExtra.totalSessions).toBe(1);

    mods.conn.closeDb();
  });
});

describe.skipIf(!driverAvailable)("#236 — one row per project, not per dir-name spelling", () => {
  // The encoded dir name keeps the drive letter's case, so the same folder can
  // be recorded as both `C--dev-app` and `c--dev-app` while `toSlug`
  // lowercases both to one slug. Grouping on project_dir_name split those into
  // two rows sharing a projectSlug, and every /usage render site keys on
  // projectSlug — hence duplicate React keys.
  //
  // Driven through raw inserts rather than the ingest path on purpose: Windows
  // filesystems are case-insensitive, so the two spellings cannot exist as
  // sibling directories on the machine this most affects. The query is what
  // changed, so the query is what this drives.
  it("folds dir-name case variants of one slug into a single byProject/projectDetails row", async () => {
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    const slug = "dev-app";
    const homeKey = normalizePathKey(path.join(tmpHome, ".claude"));

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    // Same project, same home — recorded under three spellings of one
    // directory. `C--Dev-App` is the case that matters beyond the drive
    // letter: Windows is case-insensitive for the WHOLE path, so folding
    // only the leading character would still split this one off (Codex
    // review round 2, PR #415).
    for (const [id, dirName, tokens, cost] of [
      ["sess-upper", "C--dev-app", 100, 1],
      ["sess-lower", "c--dev-app", 300, 3],
      ["sess-mixed", "C--Dev-App", 600, 6],
    ] as const) {
      insertSession.run(id, slug, dirName, `/tmp/${id}.jsonl`, homeKey,
        "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
      insertTurn.run(id, "2025-01-01T10:00:00Z", tokens, cost);
    }

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);

    // One row, and it carries the SUM of both spellings — folding must not
    // drop a variant's spend, which is the failure mode that would make this
    // look fixed while under-reporting cost.
    expect(report.byProject).toHaveLength(1);
    expect(report.byProject[0].projectSlug).toBe(slug);
    expect(report.byProject[0].tokens).toBe(1000);
    expect(report.byProject[0].cost).toBeCloseTo(10);

    expect(report.projectDetails).toHaveLength(1);
    expect(report.projectDetails[0].projectSlug).toBe(slug);
    expect(report.projectDetails[0].cost).toBeCloseTo(10);

    // The invariant the render sites actually depend on.
    const slugs = report.byProject.map((r) => r.projectSlug);
    expect(new Set(slugs).size).toBe(slugs.length);

    mods.conn.closeDb();
  });

  it("folds POSIX case variants only when the home is recorded case-insensitive", async () => {
    // #416. A macOS volume is case-insensitive by default, so one project can
    // be recorded as both `-Users-me-Dev-app` and `-users-me-dev-app`. Verified
    // against the real `toSlug`: both produce one slug. The Windows fold does
    // not reach them — they have no `X--` prefix — so the project's cost split
    // across two rows.
    //
    // The rule needs a fact the query layer cannot obtain, so it is RECORDED at
    // ingest and read back here. Both directions are asserted, because folding
    // unconditionally is the worse bug: on Linux `/home/me/Dev` and
    // `/home/me/dev` really are two projects.
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    const insensitiveHome = normalizePathKey(path.join(tmpHome, "mac", ".claude"));
    const sensitiveHome = normalizePathKey(path.join(tmpHome, "linux", ".claude"));

    db.prepare(
      "INSERT INTO home_properties (home_key, case_sensitive, probed_at) VALUES (?, ?, ?)"
    ).run(insensitiveHome, 0, "2026-03-01T00:00:00Z");
    db.prepare(
      "INSERT INTO home_properties (home_key, case_sensitive, probed_at) VALUES (?, ?, ?)"
    ).run(sensitiveHome, 1, "2026-03-01T00:00:00Z");

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    const slug = "users-me-dev-app";
    for (const [id, dirName, home, tokens, cost] of [
      ["mac-upper", "-Users-me-Dev-app", insensitiveHome, 100, 1],
      ["mac-lower", "-users-me-dev-app", insensitiveHome, 300, 3],
      ["linux-upper", "-Users-me-Dev-app", sensitiveHome, 700, 7],
      ["linux-lower", "-users-me-dev-app", sensitiveHome, 900, 9],
    ] as const) {
      insertSession.run(id, slug, dirName, `/tmp/${id}.jsonl`, home,
        "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
      insertTurn.run(id, "2025-01-01T10:00:00Z", tokens, cost);
    }

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    const byHome = new Map(report.byProject.map((r) => [r.tokens, r]));

    // The case-INSENSITIVE home: one row carrying both spellings' spend.
    expect([...byHome.keys()]).toContain(400);
    // The case-SENSITIVE home: still two rows, because they are two directories.
    expect([...byHome.keys()]).toContain(700);
    expect([...byHome.keys()]).toContain(900);
    // Three rows total, not two and not four.
    expect(report.byProject).toHaveLength(3);
    // And no spend was lost or double-counted on the way.
    expect(report.byProject.reduce((s, r) => s + r.tokens, 0)).toBe(2000);

    mods.conn.closeDb();
  });

  it("does not fold POSIX variants when no verdict was recorded", async () => {
    // Unknown is not "insensitive". A home that was never probed — an older
    // index, an unreadable volume, one that has gone away — must keep today's
    // behaviour, because over-merging silently sums two real projects into one
    // number while under-merging shows one project as two visible rows. Only
    // the second is recoverable by looking at it.
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    const unprobed = normalizePathKey(path.join(tmpHome, "unknown", ".claude"));
    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    const slug = "users-me-dev-app";
    insertSession.run("a", slug, "-Users-me-Dev-app", "/tmp/a.jsonl", unprobed,
      "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
    insertTurn.run("a", "2025-01-01T10:00:00Z", 100, 1);
    insertSession.run("b", slug, "-users-me-dev-app", "/tmp/b.jsonl", unprobed,
      "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
    insertTurn.run("b", "2025-01-01T10:00:00Z", 300, 3);

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    expect(report.byProject).toHaveLength(2);

    mods.conn.closeDb();
  });

  it("keeps two DRIVES apart even though they slugify identically", async () => {
    // The other side of the same identity question, and the reason the fold
    // is drive-letter-case-only rather than dropping project_dir_name from
    // the grouping: `toSlug` strips the drive prefix, so C:\dev\app and
    // D:\dev\app produce one slug for two genuinely different projects. The
    // encoded dir name is the only thing left that tells them apart — merging
    // them would sum unrelated spend into one row and label it with whichever
    // directory won. (Codex review, PR #415.)
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    const slug = "dev-app";
    const homeKey = normalizePathKey(path.join(tmpHome, ".claude"));

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    for (const [id, dirName, tokens, cost] of [
      ["sess-c", "C--dev-app", 100, 1],
      ["sess-d", "D--dev-app", 300, 3],
    ] as const) {
      insertSession.run(id, slug, dirName, `/tmp/${id}.jsonl`, homeKey,
        "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
      insertTurn.run(id, "2025-01-01T10:00:00Z", tokens, cost);
    }

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);

    expect(report.byProject).toHaveLength(2);
    expect(new Set(report.byProject.map((r) => r.projectDirName))).toEqual(
      new Set(["C--dev-app", "D--dev-app"])
    );
    // Each keeps its own spend rather than being summed into one row.
    expect(new Set(report.byProject.map((r) => r.tokens))).toEqual(new Set([100, 300]));

    mods.conn.closeDb();
  });

  it("does NOT case-fold POSIX-encoded directories", async () => {
    // The guard on the fold. POSIX filesystems are case-SENSITIVE, so
    // `/home/me/Dev/app` and `/home/me/dev/app` are two real directories that
    // happen to slugify alike. Only the `[A-Za-z]--` Windows shape is folded;
    // these encode with a leading dash and must stay separate, or a Linux/WSL
    // user's two projects merge into one row.
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    const slug = "home-me-dev-app";
    const homeKey = normalizePathKey(path.join(tmpHome, ".claude"));

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    for (const [id, dirName, tokens, cost] of [
      ["sess-lower", "-home-me-dev-app", 100, 1],
      ["sess-upper", "-home-me-Dev-app", 300, 3],
    ] as const) {
      insertSession.run(id, slug, dirName, `/tmp/${id}.jsonl`, homeKey,
        "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
      insertTurn.run(id, "2025-01-01T10:00:00Z", tokens, cost);
    }

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    expect(report.byProject).toHaveLength(2);
    expect(new Set(report.byProject.map((r) => r.tokens))).toEqual(new Set([100, 300]));

    mods.conn.closeDb();
  });

  it("folds NON-ASCII Windows directory casing too", async () => {
    // SQLite's LOWER() folds ASCII only, so doing this in SQL would leave
    // `C--École-app` and `c--école-app` as separate keys while toSlug — JS
    // `.toLowerCase()` before it strips non-ASCII — maps both to one slug.
    // That is the same split #236 is about, surviving on exactly the paths
    // least likely to be noticed. The fold is in JS for this reason.
    // (Codex review round 3, PR #415.)
    const mods = await reloadModules();
    const init = await mods.mig.initDb();
    expect(init.available).toBe(true);
    const db = (await mods.conn.getDb())!;

    // What toSlug actually produces for both spellings: non-ASCII is
    // lowercased first, then replaced, so both collapse to the same slug.
    const slug = "-cole-app";
    const homeKey = normalizePathKey(path.join(tmpHome, ".claude"));

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, project_slug, project_dir_name, file_path, file_mtime_ms,
          file_size, home_key, start_ts, end_ts, assistant_turn_count,
          indexed_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1, 0)`
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns
         (session_id, turn_index, ts, role, model, input_tokens, output_tokens, cost_usd)
       VALUES (?, 0, ?, 'assistant', 'claude-opus-4-7', ?, 0, ?)`
    );

    for (const [id, dirName, tokens, cost] of [
      ["sess-upper", "C--École-app", 100, 1],
      ["sess-lower", "c--école-app", 300, 3],
    ] as const) {
      insertSession.run(id, slug, dirName, `/tmp/${id}.jsonl`, homeKey,
        "2025-01-01T10:00:00Z", "2025-01-01T10:05:00Z");
      insertTurn.run(id, "2025-01-01T10:00:00Z", tokens, cost);
    }

    const report = mods.fromDb.loadUsageReportFromSql(db, "all", slug);
    expect(report.byProject).toHaveLength(1);
    expect(report.byProject[0].tokens).toBe(400);
    expect(report.byProject[0].cost).toBeCloseTo(4);

    mods.conn.closeDb();
  });
});
