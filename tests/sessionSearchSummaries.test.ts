import { describe, it, expect, vi } from "vitest";
import type { SessionSummary } from "@/lib/types";

// The server's search without an index (#700): the Sessions list no longer
// carries session text, so this scan is the only content search the page has
// under MINDER_USE_DB=0 and in demo mode.

vi.mock("@/lib/scanner/claudeConversations", () => ({
  scanAllSessions: vi.fn(),
  scanSessionDetail: vi.fn(),
}));
vi.mock("@/lib/demo/demoMode", () => ({ demoMode: vi.fn(async () => false), demoModeEnv: () => false }));

import { installIsolatedState } from "./_helpers/isolatedState";
import { searchSessionSummaries, withoutSearchableText } from "@/lib/data/sessionSearchSummaries";

// No index for the whole file: the pure tests don't care, the façade test needs it.
const state = installIsolatedState({ prefix: "pm-search-summaries-", env: { MINDER_USE_DB: "0" } });

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    projectPath: "C:\\dev\\app",
    projectSlug: "app",
    projectName: "C--dev-app",
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costEstimate: 0,
    toolUsage: {},
    modelsUsed: [],
    subagentCount: 0,
    errorCount: 0,
    isActive: false,
    status: "idle",
    skillsUsed: {},
    ...over,
  } as SessionSummary;
}

describe("searchSessionSummaries", () => {
  const older = session("old", {
    endTime: "2026-10-01T00:00:00Z",
    searchableText: "we discussed the Tokenizer rewrite at length",
  });
  const newer = session("new", {
    endTime: "2026-10-10T00:00:00Z",
    searchableText: "a second look at the tokenizer",
  });
  const titled = session("titled", {
    endTime: "2026-10-05T00:00:00Z",
    generatedTitle: "Tokenizer cleanup",
  });

  it("matches content case-insensitively, most recent first, with a snippet", () => {
    const hits = searchSessionSummaries([older, newer], "TOKENIZER", "prompts");
    expect(hits.map((h) => h.sessionId)).toEqual(["new", "old"]);
    expect(hits[0]).toMatchObject({ source: "prompts", ranks: { prompts: 1 } });
    expect(hits[1].snippet).toContain("Tokenizer rewrite");
  });

  it("matches inside a word, which the FTS path cannot", () => {
    const s = session("mid", { searchableText: "the reingest pass finished" });
    expect(searchSessionSummaries([s], "ingest").map((h) => h.sessionId)).toEqual(["mid"]);
  });

  it("windows the snippet around the match and marks the cut ends", () => {
    const text = `${"a".repeat(500)} needle ${"b".repeat(500)}`;
    const [hit] = searchSessionSummaries([session("w", { searchableText: text })], "needle");
    expect(hit.snippet!.startsWith("…")).toBe(true);
    expect(hit.snippet!.endsWith("…")).toBe(true);
    expect(hit.snippet).toContain("needle");
    expect(hit.snippet!.length).toBeLessThan(250);
  });

  it("honours scope: titles ignore text, prompts ignore titles", () => {
    const all = [older, newer, titled];
    expect(searchSessionSummaries(all, "tokenizer", "titles").map((h) => h.sessionId)).toEqual(["titled"]);
    expect(searchSessionSummaries(all, "tokenizer", "prompts").map((h) => h.sessionId)).toEqual(["new", "old"]);
    const both = searchSessionSummaries(all, "tokenizer", "both");
    expect(both.map((h) => h.sessionId)).toEqual(["new", "titled", "old"]);
    expect(both.find((h) => h.sessionId === "titled")).toMatchObject({ source: "titles" });
    expect(both.find((h) => h.sessionId === "titled")!.snippet).toBeUndefined();
  });

  it("applies facets before the limit (#425)", () => {
    const starred = session("starred", {
      endTime: "2026-09-01T00:00:00Z",
      starredAt: "2026-09-02T00:00:00Z",
      searchableText: "tokenizer",
    });
    const hits = searchSessionSummaries([older, newer, starred], "tokenizer", "both", 1, { starredOnly: true });
    expect(hits.map((h) => h.sessionId)).toEqual(["starred"]);
  });

  it("buckets an empty entrypoint as unknown and defaults source to claude", () => {
    const blank = session("blank", { entrypoint: "", searchableText: "tokenizer" });
    const cli = session("cli", { entrypoint: "cli", source: "codex", searchableText: "tokenizer" });
    expect(searchSessionSummaries([blank, cli], "tokenizer", "both", 50, { entrypoint: "unknown" }).map((h) => h.sessionId)).toEqual(["blank"]);
    expect(searchSessionSummaries([blank, cli], "tokenizer", "both", 50, { source: "claude" }).map((h) => h.sessionId)).toEqual(["blank"]);
  });

  it("returns nothing for a blank query", () => {
    expect(searchSessionSummaries([older], "   ")).toEqual([]);
  });
});

describe("withoutSearchableText", () => {
  it("drops the field and leaves the caller's objects alone", () => {
    const s = session("x", { searchableText: "secret text" });
    const [out] = withoutSearchableText([s]);
    expect("searchableText" in out).toBe(false);
    expect(out.sessionId).toBe("x");
    expect(s.searchableText).toBe("secret text");
  });

  it("returns the same array when nothing carries text (the index path)", () => {
    const list = [session("a"), session("b")];
    expect(withoutSearchableText(list)).toBe(list);
  });
});

describe("searchSessions without an index (MINDER_USE_DB=0)", () => {
  it("answers from the session summaries instead of returning no hits", async () => {
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    vi.mocked(scanAllSessions).mockResolvedValue([
      session("hit", { searchableText: "please fix the flaky tokenizer test" }),
      session("miss", { searchableText: "unrelated" }),
    ]);
    const { searchSessions } = await import("@/lib/data");
    const result = await searchSessions("flaky", "both", 50);
    expect(result.meta.backend).toBe("file");
    expect(result.hits.map((h) => h.sessionId)).toEqual(["hit"]);
    expect(result.hits[0].snippet).toContain("flaky tokenizer");
  });

  it("reuses one session list across searches instead of re-sweeping per keystroke", async () => {
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    vi.mocked(scanAllSessions).mockClear();
    vi.mocked(scanAllSessions).mockResolvedValue([session("a", { searchableText: "tokenizer" })]);
    const { searchSessions } = await import("@/lib/data");
    await searchSessions("tok", "both", 50);
    await searchSessions("token", "both", 50);
    expect(scanAllSessions).toHaveBeenCalledTimes(1);
  });
});

describe("getSessionsList never carries searchableText (#700)", () => {
  // Every caller sends the list out of the server (`/api/sessions`, MCP), and
  // the text was 13 MB of a 34 MB response. The file parse still fills it.
  it("strips it on the file-parse path", async () => {
    await state.reload();
    const { scanAllSessions } = await import("@/lib/scanner/claudeConversations");
    vi.mocked(scanAllSessions).mockResolvedValue([
      session("a", { searchableText: "x".repeat(4000) }),
      session("b"),
    ]);
    const { getSessionsList } = await import("@/lib/data");
    const { sessions, meta } = await getSessionsList();
    expect(meta.backend).toBe("file");
    expect(sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    for (const s of sessions) expect("searchableText" in s).toBe(false);
  });
});
