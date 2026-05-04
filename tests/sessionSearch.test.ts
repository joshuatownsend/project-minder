import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Tests for `src/lib/data/sessionSearch.ts`. We drive a real ingest into
// a tmp DB (better-sqlite3 required) so the FTS5 triggers populate
// `prompts_fts` naturally — no need to mirror that machinery in mocks.
//
// Skipped when better-sqlite3 isn't loadable (matches the rest of the
// SQL-path tests).

let driverAvailable: boolean;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3");
  driverAvailable = true;
} catch {
  driverAvailable = false;
}

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

interface JsonlEntry {
  type: "user" | "assistant";
  timestamp: string;
  message?: any;
  slug?: string;
}

async function writeJsonl(filePath: string, entries: JsonlEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userTurn(ts: string, text: string): JsonlEntry {
  return { type: "user", timestamp: ts, message: { content: [{ type: "text", text }] } };
}

function assistantTurn(ts: string, model: string, text: string, slug?: string): JsonlEntry {
  const entry: JsonlEntry = {
    type: "assistant",
    timestamp: ts,
    message: {
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
  };
  if (slug) entry.slug = slug;
  return entry;
}

async function reload() {
  vi.resetModules();
  delete (globalThis as { __minderDb?: unknown }).__minderDb;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return {
    conn: await import("@/lib/db/connection"),
    mig: await import("@/lib/db/migrations"),
    ingest: await import("@/lib/db/ingest"),
    search: await import("@/lib/data/sessionSearch"),
  };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-search-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!driverAvailable)("buildFtsQuery", () => {
  it("returns null on empty / whitespace-only input", async () => {
    const { search } = await reload();
    expect(search.buildFtsQuery("")).toBeNull();
    expect(search.buildFtsQuery("   ")).toBeNull();
    expect(search.buildFtsQuery("\t\n")).toBeNull();
  });

  it("escapes quotes and adds a prefix wildcard per token", async () => {
    const { search } = await reload();
    expect(search.buildFtsQuery("auth")).toBe('"auth"*');
    expect(search.buildFtsQuery("auth login")).toBe('"auth"* "login"*');
    // Internal double-quotes get doubled per FTS5 spec.
    expect(search.buildFtsQuery('say "hi"')).toBe('"say"* """hi"""*');
  });

  it("preserves FTS5 sigils as literal characters by quoting", async () => {
    const { search } = await reload();
    // FTS5 sigils (`:`, `(`, `)`, `*`, `NEAR`) carry meaning OUTSIDE
    // quotes; inside double-quotes they're literal characters. The
    // expected shape pins exact wrapping so a future tokenizer change
    // that accidentally drops the prefix-`*` or the surrounding quotes
    // surfaces immediately.
    const expr = search.buildFtsQuery("a:b c(d) NEAR e*");
    expect(expr).toMatch(/^"a:b"\* "c\(d\)"\* "NEAR"\* "e\*"\*$/);
  });
});

describe.skipIf(!driverAvailable)("searchSessionsInDb", () => {
  async function setup() {
    const reloaded = await reload();
    await reloaded.mig.initDb();
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    return { ...reloaded, projectsDir };
  }

  it("returns prompts hits ranked by FTS5 bm25", async () => {
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "search-a.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "the migration is failing on production"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "looking at migration logs"),
    ]);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "search-b.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "what's the status of the deploy?"),
      assistantTurn("2026-04-30T11:00:01Z", "claude-sonnet-4-5", "all green"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "migration", "prompts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.find((h) => h.sessionId === "search-a")).toBeDefined();
    expect(hits.find((h) => h.sessionId === "search-b")).toBeUndefined();
    expect(hits[0].source).toBe("prompts");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
    conn.closeDb();
  });

  it("titles scope matches against slug column", async () => {
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "title-a.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "do the thing"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok", "shimmering-quokka-prancing"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "quokka", "titles");
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("title-a");
    expect(hits[0].source).toBe("titles");
    conn.closeDb();
  });

  it("titles scope matches against project_dir_name", async () => {
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-distinctive-app", "p-a.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "hi"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "distinctive", "titles");
    expect(hits.find((h) => h.sessionId === "p-a")).toBeDefined();
    conn.closeDb();
  });

  it("both scope unions hits and dedupes by sessionId", async () => {
    // Same session matches via slug AND prompt — should appear once.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "dual-a.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "let's debug the gizmo"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok the gizmo is broken", "shiny-gizmo-finder"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "gizmo", "both");
    expect(hits.length).toBe(1); // dedup by session_id
    expect(hits[0].sessionId).toBe("dual-a");
    conn.closeDb();
  });

  it("returns [] for empty query", async () => {
    const { conn, search } = await setup();
    const db = (await conn.getDb())!;
    expect(search.searchSessionsInDb(db, "", "both")).toEqual([]);
    expect(search.searchSessionsInDb(db, "   ", "both")).toEqual([]);
    conn.closeDb();
  });

  it("throws SessionSearchError on invalid scope", async () => {
    const { conn, search } = await setup();
    const db = (await conn.getDb())!;
    expect(() => search.searchSessionsInDb(db, "foo", "bogus" as any)).toThrow(
      search.SessionSearchError
    );
    conn.closeDb();
  });

  it("respects limit parameter", async () => {
    const { conn, ingest, search, projectsDir } = await setup();
    for (let i = 0; i < 5; i++) {
      await writeJsonl(path.join(projectsDir, "C--dev-app", `lim-${i}.jsonl`), [
        userTurn(`2026-04-30T10:0${i}:00Z`, "the unique-keyword-zzz appears here"),
        assistantTurn(`2026-04-30T10:0${i}:01Z`, "claude-sonnet-4-5", "ok"),
      ]);
    }
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "unique-keyword-zzz", "prompts", 3);
    expect(hits.length).toBe(3);
    conn.closeDb();
  });
});
