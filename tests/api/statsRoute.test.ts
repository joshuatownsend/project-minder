/**
 * Characterization tests for GET /api/stats
 *
 * The route is a thin ETag wrapper around `@/lib/server/queries/stats`
 * (`getStatsInputs` + `buildStatsResponse`) plus a Claude stats-cache mtime
 * fold-in for the ETag. Covers:
 *  - Happy path: 200, body from buildStatsResponse, X-Minder-Backend header
 *  - 304 short-circuit when If-None-Match matches (buildStatsResponse never runs)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock lib boundaries BEFORE importing the route (vi.mock hoisting).
vi.mock("@/lib/scanner/claudeStats", () => ({
  getStatsCacheMtimeMs: vi.fn(async () => 0),
}));

vi.mock("@/lib/httpCache", () => ({
  computeETag: vi.fn(() => '"stats-etag"'),
  ifNoneMatch: vi.fn(() => null),
  jsonWithETag: vi.fn((body: unknown) => NextResponse.json(body)),
}));

vi.mock("@/lib/server/queries/stats", () => ({
  getStatsInputs: vi.fn(),
  buildStatsResponse: vi.fn(),
}));

import { getStatsCacheMtimeMs } from "@/lib/scanner/claudeStats";
import { ifNoneMatch } from "@/lib/httpCache";
import { getStatsInputs, buildStatsResponse } from "@/lib/server/queries/stats";
import { GET } from "@/app/api/stats/route";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/stats", { headers });
}

const fakeInputs = {
  result: { scannedAt: new Date("2026-06-01T00:00:00Z").toISOString() },
  usage: {},
  backend: "file" as const,
  maxMtime: 0,
};

describe("GET /api/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStatsCacheMtimeMs).mockResolvedValue(0);
    vi.mocked(getStatsInputs).mockResolvedValue(
      fakeInputs as unknown as Awaited<ReturnType<typeof getStatsInputs>>
    );
    vi.mocked(ifNoneMatch).mockReturnValue(null);
  });

  it("returns 200 with the built response body and the backend header", async () => {
    vi.mocked(buildStatsResponse).mockResolvedValue({
      totalProjects: 3,
      sessions: [],
      crossCheck: { drift: 0 },
    } as unknown as Awaited<ReturnType<typeof buildStatsResponse>>);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    const body = await res.json();
    expect(body).toMatchObject({ totalProjects: 3 });
    expect(buildStatsResponse).toHaveBeenCalledWith(fakeInputs);
  });

  it("returns an empty-shape body when buildStatsResponse reports zero projects", async () => {
    vi.mocked(buildStatsResponse).mockResolvedValue({
      totalProjects: 0,
      sessions: [],
      crossCheck: null,
    } as unknown as Awaited<ReturnType<typeof buildStatsResponse>>);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalProjects: 0, sessions: [] });
  });

  it("short-circuits to the 304 response when If-None-Match matches, without building the body", async () => {
    const notModified = new NextResponse(null, { status: 304 });
    vi.mocked(ifNoneMatch).mockReturnValue(notModified);

    const res = await GET(makeRequest({ "if-none-match": '"stats-etag"' }));

    expect(res.status).toBe(304);
    expect(buildStatsResponse).not.toHaveBeenCalled();
  });
});
