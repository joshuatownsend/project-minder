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
import { CatalogHomeError } from "@/lib/indexer/homes";
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
      unresolvedPlugins: [],
    });

    const res = await GET(makeRequest({ source: "user", project: "my-app", q: "review" }));

    expect(res.status).toBe(200);
    expect(loadAgentsResponse).toHaveBeenCalledWith("user", "my-app", "review", null, true);
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    // The route unwraps { data, backend } and returns `data` as the body directly.
    const body = await res.json();
    expect(body).toMatchObject([{ entry: { id: "a1" } }]);
  });

  it("passes null for absent query params", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({ data: [], backend: "db", unresolvedPlugins: [] });

    await GET(makeRequest({}));

    expect(loadAgentsResponse).toHaveBeenCalledWith(null, null, null, null, true);
  });

  it("returns an empty data array when the catalog is empty", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({ data: [], backend: "file", unresolvedPlugins: [] });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
  it("forwards ?home= and ?scope=home and surfaces unresolved plugins in a header (#553)", async () => {
    vi.mocked(loadAgentsResponse).mockResolvedValue({
      data: [],
      backend: "file",
      home: { key: "//wsl.localhost/ubuntu/home/me/.claude", path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude", primary: false },
      unresolvedPlugins: ["github", "my plugin"],
    });

    const res = await GET(makeRequest({ home: "//wsl.localhost/ubuntu/home/me/.claude", scope: "home" }));

    // `scope=home` → no project walk (fifth argument false).
    expect(loadAgentsResponse).toHaveBeenCalledWith(null, null, null, "//wsl.localhost/ubuntu/home/me/.claude", false);
    expect(res.headers.get("X-Minder-Unresolved-Plugins")).toBe("github,my%20plugin");
  });

  it("answers a home the catalog cannot walk with its status and reason, never a 500", async () => {
    vi.mocked(loadAgentsResponse).mockRejectedValueOnce(
      new CatalogHomeError("unavailable", "//wsl.localhost/debian/home/me/.claude", { reason: "wsl-stopped", distro: "Debian" })
    );
    const down = await GET(makeRequest({ home: "//wsl.localhost/debian/home/me/.claude" }));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ problem: "unavailable", reason: "wsl-stopped", distro: "Debian" });

    vi.mocked(loadAgentsResponse).mockRejectedValueOnce(new CatalogHomeError("unknown", "nope"));
    const missing = await GET(makeRequest({ home: "nope" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ problem: "unknown", home: "nope" });
  });
});
