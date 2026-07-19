import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sessionsQuery,
  sessionDetailQuery,
  statsQuery,
  usageQuery,
  agentsQuery,
  skillsQuery,
  insightsListQuery,
  insightDetailQuery,
} from "@/lib/queryOptions";

// These factories are the single source of truth shared by the data hooks
// (useQuery) and the hover-prefetch path (prefetchQuery). The risk the
// refactor introduces is URL / queryKey drift, so we assert both halves:
// the key shape and the exact request each queryFn fires.

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

/** Stub a single fetch response. */
function mockResponse(body: unknown, { ok = true, status = 200 } = {}) {
  fetchMock.mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

/** Invoke a factory's queryFn with a minimal QueryFunctionContext. */
function runFn<T>(options: { queryFn?: unknown }): Promise<T> {
  const fn = options.queryFn as (ctx: { signal?: AbortSignal }) => Promise<T>;
  return fn({ signal: undefined });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queryOptions — keys", () => {
  it("mirror the queryKeys factory shapes", () => {
    expect(sessionsQuery().queryKey).toEqual(["sessions", "list"]);
    expect(sessionDetailQuery("abc").queryKey).toEqual([
      "sessions",
      "detail",
      "abc",
    ]);
    expect(statsQuery().queryKey).toEqual(["stats"]);
    expect(usageQuery("30d").queryKey).toEqual(["usage", "30d", null, null]);
    expect(usageQuery("week", "proj").queryKey).toEqual([
      "usage",
      "week",
      "proj",
      null,
    ]);
    expect(agentsQuery().queryKey).toEqual(["agents", null, null, null]);
    expect(skillsQuery("user").queryKey).toEqual([
      "skills",
      "user",
      null,
      null,
    ]);
    expect(insightsListQuery().queryKey).toEqual([
      "insights",
      "list",
      null,
      null,
    ]);
    expect(insightDetailQuery("my-proj").queryKey).toEqual([
      "insights",
      "detail",
      "my-proj",
    ]);
  });
});

describe("queryOptions — requests", () => {
  it("sessionsQuery fetches /api/sessions and returns the body", async () => {
    mockResponse([{ sessionId: "s1" }]);
    const data = await runFn(sessionsQuery());
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", { signal: undefined });
    expect(data).toEqual([{ sessionId: "s1" }]);
  });

  it("sessionsQuery throws on a non-OK response", async () => {
    mockResponse(null, { ok: false, status: 500 });
    await expect(runFn(sessionsQuery())).rejects.toThrow(/500/);
  });

  it("sessionDetailQuery resolves null on a 404 (genuinely not found)", async () => {
    mockResponse(null, { ok: false, status: 404 });
    const data = await runFn(sessionDetailQuery("missing"));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/missing", {
      signal: undefined,
    });
    expect(data).toBeNull();
  });

  it("sessionDetailQuery throws on a transient non-404 failure (not cached as null)", async () => {
    // A 500 must NOT resolve null — otherwise the hover-prefetch would cache
    // `null` as fresh data and a click would show "not found" without retrying.
    mockResponse(null, { ok: false, status: 500 });
    await expect(runFn(sessionDetailQuery("s1"))).rejects.toThrow(/500/);
  });

  it("statsQuery fetches /api/stats", async () => {
    mockResponse({ totals: {} });
    await runFn(statsQuery());
    expect(fetchMock).toHaveBeenCalledWith("/api/stats", { signal: undefined });
  });

  it("usageQuery passes period and omits an undefined project", async () => {
    mockResponse({ turns: [] });
    await runFn(usageQuery("30d"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/usage?period=30d");
  });

  it("usageQuery appends a project when given", async () => {
    mockResponse({ turns: [] });
    await runFn(usageQuery("week", "minder"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/usage?period=week&project=minder");
  });

  it("agentsQuery omits the query string when unfiltered", async () => {
    mockResponse([]);
    await runFn(agentsQuery());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agents");
  });

  it("agentsQuery builds source/project/q params when filtered", async () => {
    mockResponse([]);
    await runFn(agentsQuery("user", "minder", "lint"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/agents?source=user&project=minder&q=lint",
    );
  });

  it("skillsQuery omits the query string when unfiltered", async () => {
    mockResponse([]);
    await runFn(skillsQuery());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/skills");
  });

  it("insightsListQuery omits the query string when unfiltered", async () => {
    mockResponse({ insights: [], total: 0 });
    await runFn(insightsListQuery());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/insights");
  });

  it("insightsListQuery builds project/q params when filtered", async () => {
    mockResponse({ insights: [], total: 0 });
    await runFn(insightsListQuery("minder", "race"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/insights?project=minder&q=race",
    );
  });

  it("insightDetailQuery resolves null on a 404 (genuinely not found)", async () => {
    mockResponse(null, { ok: false, status: 404 });
    const data = await runFn(insightDetailQuery("ghost"));
    expect(fetchMock).toHaveBeenCalledWith("/api/insights/ghost", {
      signal: undefined,
    });
    expect(data).toBeNull();
  });

  it("insightDetailQuery throws on a transient non-404 failure (not cached as null)", async () => {
    mockResponse(null, { ok: false, status: 503 });
    await expect(runFn(insightDetailQuery("minder"))).rejects.toThrow(/503/);
  });
});
