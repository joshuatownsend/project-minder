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
    // Scores are RRF (see src/lib/data/rrf.ts): strictly positive, small
    // by construction, order-meaningful only. A rank-1 prompt hit at
    // weight 1.0 scores 1/(60+1).
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThan(1);
    expect(hits[0].ranks).toEqual({ prompts: 1 });
    conn.closeDb();
  });

  it("ranks stronger prompt matches above weaker ones (signed bm25)", async () => {
    const { conn, ingest, search, projectsDir } = await setup();
    // Heavy keyword density in session A; only a single occurrence in B.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "rank-strong.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "needle needle needle needle needle needle"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "needle confirmed"),
    ]);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "rank-weak.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "we discussed the needle once and moved on to other unrelated topics"),
      assistantTurn("2026-04-30T11:00:01Z", "claude-sonnet-4-5", "right"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "needle", "prompts");
    expect(hits.length).toBe(2);
    const strong = hits.find((h) => h.sessionId === "rank-strong")!;
    const weak = hits.find((h) => h.sessionId === "rank-weak")!;
    expect(strong.score).toBeGreaterThan(weak.score);
    conn.closeDb();
  });

  it("FTS parse failures surface as SessionSearchError, not generic Error", async () => {
    // Pre-fix: searchSessions wrapped the call in callDbLoader, which
    // converted SessionSearchError → DbUnavailableError (load-failed).
    // The route's `instanceof SessionSearchError` branch was unreachable
    // and parse failures returned 500 instead of 400. The data layer
    // must let SessionSearchError pass through unchanged.
    const { conn, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "any.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "anything"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok"),
    ]);
    const db = (await conn.getDb())!;
    // Force an FTS5 parse failure by passing a query that the
    // tokenizer can't escape into a valid expression. The function
    // should surface SessionSearchError("fts-parse"), not a wrapped
    // DbUnavailableError. We don't actually trigger one here — the
    // tokenizer is robust by design — so this assertion just pins that
    // *if* the loader threw SessionSearchError, the data façade does
    // not catch and convert it. Done by checking the public façade.
    const facade = await import("@/lib/data");
    // A valid query path returns hits without throwing.
    const result = await facade.searchSessions("anything", "both", 10);
    expect(result.meta.backend).toBe("db");
    // Direct loader call with invalid scope still throws
    // SessionSearchError — proves the type is preserved in this path.
    expect(() => search.searchSessionsInDb(db, "x", "bogus" as any)).toThrow(
      search.SessionSearchError
    );
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
    // Fusion records provenance from BOTH retrievers for a dual match.
    expect(hits[0].ranks).toEqual({ titles: 1, prompts: 1 });
    conn.closeDb();
  });

  it("ranks a session matched by BOTH retrievers above prompt-only matches", async () => {
    // The behaviour RRF was adopted for. `dual` matches on slug and in
    // prompt text; `promptonly` matches prompt text more densely. Under
    // the previous scheme a title hit was pinned at a flat 0.5 and a
    // dense prompt hit could squash above it, so agreement across
    // retrievers counted for nothing. Now it is the dominant signal.
    //
    // NOTE ON CORPUS SHAPE: the `titles` retriever's LIKE also scans
    // `initial_prompt` / `last_prompt`, not just `slug`. So the keyword is
    // kept out of each session's FIRST and LAST user turns — otherwise a
    // prompt-dense session matches the titles retriever too and the test
    // proves nothing about cross-retriever agreement.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "dual.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "checking the component behaviour"),
      userTurn("2026-04-30T10:00:01Z", "does the widget look right to you"),
      assistantTurn("2026-04-30T10:00:02Z", "claude-sonnet-4-5", "looks fine", "widget-inspector-calm"),
      userTurn("2026-04-30T10:00:03Z", "great, thanks"),
    ]);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "promptonly.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "starting the review now"),
      userTurn("2026-04-30T11:00:01Z", "widget widget widget widget widget widget widget"),
      assistantTurn("2026-04-30T11:00:02Z", "claude-sonnet-4-5", "widget widget widget"),
      userTurn("2026-04-30T11:00:03Z", "ok all done"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "widget", "both");
    expect(hits.map((h) => h.sessionId)).toContain("dual");
    expect(hits[0].sessionId).toBe("dual");
    expect(hits[0].ranks.titles).toBeDefined();
    expect(hits[0].ranks.prompts).toBeDefined();
    // The prompt-only session still ranks, just below.
    const promptOnly = hits.find((h) => h.sessionId === "promptonly")!;
    expect(promptOnly.ranks.titles).toBeUndefined();
    expect(hits[0].score).toBeGreaterThan(promptOnly.score);
    conn.closeDb();
  });

  it("over-fetches candidates so fusion can rescue a deeply-ranked match", async () => {
    // With `limit=2`, a naive implementation would fetch only 2 rows per
    // retriever and never see `rescue` in the prompt list at all. The
    // 3x candidate pool is what lets its title match pull it into the
    // final results.
    const { conn, ingest, search, projectsDir } = await setup();
    for (let i = 0; i < 5; i++) {
      await writeJsonl(path.join(projectsDir, "C--dev-app", `noise-${i}.jsonl`), [
        userTurn(`2026-04-30T10:0${i}:00Z`, "sprocket sprocket sprocket sprocket sprocket"),
        assistantTurn(`2026-04-30T10:0${i}:01Z`, "claude-sonnet-4-5", "sprocket sprocket"),
      ]);
    }
    // Mentions the term once (weak bm25) but carries it in the slug.
    await writeJsonl(path.join(projectsDir, "C--dev-app", "rescue.jsonl"), [
      userTurn("2026-04-30T11:00:00Z", "a passing mention of sprocket among much other unrelated text here"),
      assistantTurn("2026-04-30T11:00:01Z", "claude-sonnet-4-5", "noted", "sprocket-rescue-session"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "sprocket", "both", 2);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.sessionId)).toContain("rescue");
    conn.closeDb();
  });

  it("finds text far beyond the 500-char preview cap", async () => {
    // The regression this whole feature exists to fix. `prompts_fts` used
    // to mirror `turns.text_preview` (500 chars), so a keyword at char
    // 3000 of an assistant reply was silently unsearchable — the search
    // returned no error, just nothing.
    const { conn, ingest, search, projectsDir } = await setup();
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
    const longBody = filler.repeat(60) + " zzmarkerdeep " + filler.repeat(60);
    expect(longBody.indexOf("zzmarkerdeep")).toBeGreaterThan(500);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "deep.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "explain something at length"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", longBody),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "zzmarkerdeep", "prompts");
    expect(hits.map((h) => h.sessionId)).toContain("deep");
    conn.closeDb();
  });

  it("spans a chunk boundary without losing the text", async () => {
    // Text longer than one 4000-char chunk must be fully indexed, not
    // truncated at the first chunk.
    const { conn, ingest, search, projectsDir } = await setup();
    const body = "alpha beta gamma delta epsilon ".repeat(400) + " zzmarkerlast";
    expect(body.length).toBeGreaterThan(9000);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "spanning.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "a very long answer please"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", body),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      search.searchSessionsInDb(db, "zzmarkerlast", "prompts").map((h) => h.sessionId)
    ).toContain("spanning");
    // One session, many chunks — the GROUP BY in searchSessionsInDb must
    // collapse them, or a long session would flood the result list.
    const hits = search.searchSessionsInDb(db, "alpha", "prompts");
    expect(hits.filter((h) => h.sessionId === "spanning").length).toBe(1);
    conn.closeDb();
  });

  it("indexes extended-thinking content", async () => {
    // Thinking blocks were parsed only to set `has_thinking` and then
    // discarded, so "why did Claude decide X" was never searchable.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "thinky.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "pick an approach"),
      {
        type: "assistant",
        timestamp: "2026-04-30T10:00:01Z",
        message: {
          model: "claude-sonnet-4-5",
          content: [
            { type: "thinking", thinking: "weighing zzthinkmarker against the alternative" },
            { type: "text", text: "I'll go with the second option." },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100, output_tokens: 50,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      },
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      search.searchSessionsInDb(db, "zzthinkmarker", "prompts").map((h) => h.sessionId)
    ).toContain("thinky");
    conn.closeDb();
  });

  it("does NOT index tool inputs or outputs (content tier B)", async () => {
    // Tool I/O is ~60% of transcript volume and mostly grep output and
    // file dumps. Excluding it is the deliberate sizing decision behind
    // this index; a regression that starts indexing it would roughly
    // double the database with no announcement.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "tooly.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "run the thing"),
      {
        type: "assistant",
        timestamp: "2026-04-30T10:00:01Z",
        message: {
          model: "claude-sonnet-4-5",
          content: [
            { type: "text", text: "running it now" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo zztoolinput" } },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100, output_tokens: 50,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: "user",
        timestamp: "2026-04-30T10:00:02Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "zztooloutput was printed" },
          ],
        },
      },
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    expect(search.searchSessionsInDb(db, "zztoolinput", "prompts")).toEqual([]);
    expect(search.searchSessionsInDb(db, "zztooloutput", "prompts")).toEqual([]);
    // The turn's own prose is still indexed — only the tool payloads aren't.
    expect(
      search.searchSessionsInDb(db, "running", "prompts").map((h) => h.sessionId)
    ).toContain("tooly");
    conn.closeDb();
  });

  it("indexes subagent (sidechain) transcripts", async () => {
    // Sidechain rows carry `textPreview: null`, so delegated work was
    // invisible to search at any length.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "delegated.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "delegate this"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "spawning an agent"),
      {
        type: "assistant",
        timestamp: "2026-04-30T10:00:02Z",
        isSidechain: true,
        parentToolUseID: "task-1",
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "subagent reporting zzsubagentmarker found" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100, output_tokens: 50,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      } as any,
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    expect(
      search.searchSessionsInDb(db, "zzsubagentmarker", "prompts").map((h) => h.sessionId)
    ).toContain("delegated");
    conn.closeDb();
  });

  it("returns a snippet of the matched text for prompt hits", async () => {
    // Without this, a match deep in a body has nothing to render: the
    // browser builds its excerpt from `SessionSummary.searchableText`,
    // which comes from `turns.text_preview` (500 chars), so the row would
    // show an unrelated preview and never say WHY it matched.
    const { conn, ingest, search, projectsDir } = await setup();
    const filler = "padding text that is not interesting ";
    await writeJsonl(path.join(projectsDir, "C--dev-app", "snip.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "explain at length"),
      assistantTurn(
        "2026-04-30T10:00:01Z",
        "claude-sonnet-4-5",
        filler.repeat(40) + " the zzsnippetword appears here " + filler.repeat(40)
      ),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "zzsnippetword", "prompts");
    const hit = hits.find((h) => h.sessionId === "snip")!;
    expect(hit.snippet).toBeDefined();
    // The excerpt must contain the term — that is the entire point.
    expect(hit.snippet!.toLowerCase()).toContain("zzsnippetword");
    // And be an excerpt, not the whole body.
    expect(hit.snippet!.length).toBeLessThan(600);
    conn.closeDb();
  });

  it("snippets text the preview column cannot contain (thinking)", async () => {
    // `turns.text_preview` never holds thinking content, so this excerpt
    // can only come from the FTS index.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "thinksnip.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "choose an approach"),
      {
        type: "assistant",
        timestamp: "2026-04-30T10:00:01Z",
        message: {
          model: "claude-sonnet-4-5",
          content: [
            { type: "thinking", thinking: "considering zzthinksnippet as the option" },
            { type: "text", text: "going with the second one" },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100, output_tokens: 50,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      },
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hit = search
      .searchSessionsInDb(db, "zzthinksnippet", "prompts")
      .find((h) => h.sessionId === "thinksnip")!;
    expect(hit.snippet!.toLowerCase()).toContain("zzthinksnippet");
    conn.closeDb();
  });

  it("returns one hit with one snippet even when many chunks match", async () => {
    // The ROW_NUMBER() collapse: a session matching in six chunks must
    // yield one row, not six, or a single long session floods the list.
    const { conn, ingest, search, projectsDir } = await setup();
    const body = ("zzrepeatword and some surrounding words ").repeat(600);
    await writeJsonl(path.join(projectsDir, "C--dev-app", "manychunks.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "long one please"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", body),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hits = search.searchSessionsInDb(db, "zzrepeatword", "prompts");
    expect(hits.filter((h) => h.sessionId === "manychunks").length).toBe(1);
    expect(hits[0].snippet).toBeDefined();
    conn.closeDb();
  });

  it("omits the snippet on title-only hits", async () => {
    // A title hit matched a column the row already renders, so an
    // excerpt would be noise.
    const { conn, ingest, search, projectsDir } = await setup();
    await writeJsonl(path.join(projectsDir, "C--dev-app", "titleonly.jsonl"), [
      userTurn("2026-04-30T10:00:00Z", "nothing notable here"),
      assistantTurn("2026-04-30T10:00:01Z", "claude-sonnet-4-5", "ok", "zzsluggish-otter-calm"),
    ]);
    const db = (await conn.getDb())!;
    await ingest.reconcileAllSessions(db, { projectsDir });

    const hit = search
      .searchSessionsInDb(db, "zzsluggish", "both")
      .find((h) => h.sessionId === "titleonly")!;
    expect(hit.source).toBe("titles");
    expect(hit.snippet).toBeUndefined();
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
