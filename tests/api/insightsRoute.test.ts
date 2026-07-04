/**
 * Characterization tests for GET /api/insights
 *
 * Thin wrapper over `@/lib/server/queries/insights` (`loadInsightsResponse`).
 * Covers:
 *  - project/q query params forwarded
 *  - Empty result → { insights: [], total: 0 }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/queries/insights", () => ({
  loadInsightsResponse: vi.fn(),
}));

import { loadInsightsResponse } from "@/lib/server/queries/insights";
import { GET } from "@/app/api/insights/route";

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/insights");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/insights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards project and q query params to loadInsightsResponse", async () => {
    vi.mocked(loadInsightsResponse).mockResolvedValue({
      insights: [{ project: "my-app", date: "2026-06-01", content: "found a bug" }],
      total: 1,
    } as unknown as Awaited<ReturnType<typeof loadInsightsResponse>>);

    const res = await GET(makeRequest({ project: "my-app", q: "bug" }));

    expect(res.status).toBe(200);
    expect(loadInsightsResponse).toHaveBeenCalledWith("my-app", "bug");
    const body = await res.json();
    expect(body).toMatchObject({ total: 1 });
  });

  it("passes null for absent query params", async () => {
    vi.mocked(loadInsightsResponse).mockResolvedValue({ insights: [], total: 0 });

    await GET(makeRequest({}));

    expect(loadInsightsResponse).toHaveBeenCalledWith(null, null);
  });

  it("returns an empty shape when no insights match", async () => {
    vi.mocked(loadInsightsResponse).mockResolvedValue({ insights: [], total: 0 });

    const res = await GET(makeRequest({ q: "nonexistent-keyword" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ insights: [], total: 0 });
  });
});
