/**
 * Characterization tests for GET /api/agents
 *
 * Thin wrapper over `@/lib/server/queries/agents` (`loadAgentsResponse`).
 * Covers:
 *  - Query params (source, project, q) forwarded to loadAgentsResponse
 *  - X-Minder-Backend header set from the response backend
 *  - Empty catalog → empty data array
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/httpCache", () => ({
  jsonWithCacheControl: vi.fn((body: unknown) => NextResponse.json(body)),
}));

vi.mock("@/lib/server/queries/agents", () => ({
  loadAgentsResponse: vi.fn(),
  invalidateAgentsRouteCache: vi.fn(),
}));

import { loadAgentsResponse } from "@/lib/server/queries/agents";
import { GET } from "@/app/api/agents/route";

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/agents");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards source/project/q query params to loadAgentsResponse", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({
      data: [{ entry: { id: "a1", name: "my-agent" } }] as unknown as Awaited<
        ReturnType<typeof loadAgentsResponse>
      >["data"],
      backend: "file",
    });

    const res = await GET(makeRequest({ source: "user", project: "my-app", q: "review" }));

    expect(res.status).toBe(200);
    expect(loadAgentsResponse).toHaveBeenCalledWith("user", "my-app", "review");
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    // The route unwraps { data, backend } and returns `data` as the body directly.
    const body = await res.json();
    expect(body).toMatchObject([{ entry: { id: "a1" } }]);
  });

  it("passes null for absent query params", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({ data: [], backend: "db" });

    await GET(makeRequest({}));

    expect(loadAgentsResponse).toHaveBeenCalledWith(null, null, null);
  });

  it("returns an empty data array when the catalog is empty", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({ data: [], backend: "file" });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
