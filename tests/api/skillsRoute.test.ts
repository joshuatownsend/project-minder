/**
 * Characterization tests for GET /api/skills
 *
 * Skills twin of agentsRoute.test.ts — thin wrapper over
 * `@/lib/server/queries/skills` (`loadSkillsResponse`). Covers:
 *  - Query params (source, project, q) forwarded to loadSkillsResponse
 *  - X-Minder-Backend header set from the response backend
 *  - Empty catalog → empty data array
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/httpCache", () => ({
  jsonWithCacheControl: vi.fn((body: unknown) => NextResponse.json(body)),
}));

vi.mock("@/lib/server/queries/skills", () => ({
  loadSkillsResponse: vi.fn(),
  invalidateSkillsRouteCache: vi.fn(),
}));

import { loadSkillsResponse } from "@/lib/server/queries/skills";
import { GET } from "@/app/api/skills/route";

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/skills");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards source/project/q query params to loadSkillsResponse", async () => {
    vi.mocked(loadSkillsResponse).mockResolvedValue({
      data: [{ entry: { id: "s1", name: "my-skill" } }] as unknown as Awaited<
        ReturnType<typeof loadSkillsResponse>
      >["data"],
      backend: "file",
    });

    const res = await GET(makeRequest({ source: "plugin", project: "my-app", q: "deploy" }));

    expect(res.status).toBe(200);
    expect(loadSkillsResponse).toHaveBeenCalledWith("plugin", "my-app", "deploy");
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    // The route unwraps { data, backend } and returns `data` as the body directly.
    const body = await res.json();
    expect(body).toMatchObject([{ entry: { id: "s1" } }]);
  });

  it("passes null for absent query params", async () => {
    vi.mocked(loadSkillsResponse).mockResolvedValue({ data: [], backend: "db" });

    await GET(makeRequest({}));

    expect(loadSkillsResponse).toHaveBeenCalledWith(null, null, null);
  });

  it("returns an empty data array when the catalog is empty", async () => {
    vi.mocked(loadSkillsResponse).mockResolvedValue({ data: [], backend: "file" });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
