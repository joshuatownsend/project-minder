/**
 * Characterization tests for GET /api/sessions
 *
 * The route warms a shared cache slot, resolves enabled adapters from config,
 * computes an ETag, and applies the shared filter chain
 * (`@/lib/server/queries/sessions`). Covers:
 *  - Query params (project, source, pr, ticket) forwarded to filterSessions
 *  - Empty result set (no matches) → empty array, 200
 *  - 304 short-circuit when If-None-Match matches (filterSessions never runs)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/httpCache", () => ({
  computeETag: vi.fn(() => '"sessions-etag"'),
  ifNoneMatch: vi.fn(() => null),
  jsonWithETag: vi.fn((body: unknown) => NextResponse.json(body)),
}));

vi.mock("@/lib/server/queries/sessions", () => ({
  getSessionsCacheSlot: vi.fn(),
  filterSessions: vi.fn(),
  getEnabledAdapters: vi.fn(),
}));

import { ifNoneMatch } from "@/lib/httpCache";
import {
  getSessionsCacheSlot,
  filterSessions,
  getEnabledAdapters,
} from "@/lib/server/queries/sessions";
import { GET } from "@/app/api/sessions/route";
import type { SessionSummary } from "@/lib/types";

const fakeSessions: SessionSummary[] = [
  {
    sessionId: "s1",
    projectSlug: "my-app",
    projectName: "my-app",
    source: "claude",
  } as unknown as SessionSummary,
];

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/sessions");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ifNoneMatch).mockReturnValue(null);
    vi.mocked(getSessionsCacheSlot).mockResolvedValue({
      result: { sessions: fakeSessions, meta: { backend: "file" } },
      cachedAt: Date.now(),
      maxSessionMs: Date.now(),
    } as unknown as Awaited<ReturnType<typeof getSessionsCacheSlot>>);
    vi.mocked(getEnabledAdapters).mockResolvedValue(new Set(["claude"]));
    vi.mocked(filterSessions).mockReturnValue(fakeSessions);
  });

  it("forwards project/source/pr/ticket query params to filterSessions", async () => {
    const req = makeRequest({
      project: "my-app",
      source: "claude",
      pr: "https://github.com/o/r/pull/1",
      ticket: "https://tracker/T-1",
    });

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(filterSessions).toHaveBeenCalledWith(
      fakeSessions,
      expect.objectContaining({
        enabledAdapters: new Set(["claude"]),
        project: "my-app",
        source: "claude",
        pr: "https://github.com/o/r/pull/1",
        ticket: "https://tracker/T-1",
      })
    );
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
  });

  it("returns an empty array when filterSessions finds no matches", async () => {
    vi.mocked(filterSessions).mockReturnValue([]);

    const res = await GET(makeRequest({ project: "nonexistent" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("short-circuits to 304 without calling filterSessions when If-None-Match matches", async () => {
    const notModified = new NextResponse(null, { status: 304 });
    vi.mocked(ifNoneMatch).mockReturnValue(notModified);

    const res = await GET(makeRequest());

    expect(res.status).toBe(304);
    expect(filterSessions).not.toHaveBeenCalled();
  });
});
