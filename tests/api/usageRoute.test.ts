/**
 * Characterization tests for GET /api/usage
 *
 * Covers:
 *  - Query params (period, project, source) are parsed and forwarded to getUsage
 *  - Valid period values pass through unchanged; invalid ones default to "30d"
 *  - Legacy period aliases ("week" → "7d", "month" → "30d") are normalized
 *  - Response carries the report body from getUsage
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock the data layer and http cache before importing the route.
vi.mock("@/lib/data", () => ({
  getUsage: vi.fn(),
  dbModeRequested: vi.fn(() => false),
}));

vi.mock("@/lib/httpCache", () => ({
  computeETag: vi.fn(() => '"abc123"'),
  ifNoneMatch: vi.fn(() => null),
  // Use the real NextResponse.json so the test can call res.json() normally.
  // The import at the top of this module is hoisted before vi.mock runs,
  // so capturing NextResponse here is safe.
  jsonWithETag: vi.fn((body: unknown) => NextResponse.json(body)),
}));

import { getUsage, dbModeRequested } from "@/lib/data";
import { computeETag } from "@/lib/httpCache";
import { GET } from "@/app/api/usage/route";
import type { UsageReport } from "@/lib/usage/types";
import { disposeAllRouteCaches } from "@/lib/routeCache";

/** Clear the route-level cache between tests.
 *
 * The route's cache (`getOrCreateRouteCache("usage", ...)`) is a named
 * instance pinned to `globalThis` via the shared route-cache registry (C3),
 * so it lives for the duration of the test run unless explicitly cleared.
 */
function clearUsageRouteCache() {
  disposeAllRouteCaches();
}

/** Minimal UsageReport shape — only the fields the test assertions inspect. */
const fakeReport: Partial<UsageReport> = {
  totalTokens: 42_000,
  totalCost: 0.42,
  byModel: [],
  byCategory: [],
  byProject: [],
};

const fakeUsageResult = {
  report: fakeReport as UsageReport,
  meta: { backend: "file" as const, maxMtimeMs: 1_000_000 },
};

/** Build a NextRequest for the usage route with optional query params. */
function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/usage");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

describe("GET /api/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the route-level in-process cache so each test gets a fresh call to getUsage.
    clearUsageRouteCache();
    vi.mocked(dbModeRequested).mockReturnValue(false);
    vi.mocked(getUsage).mockResolvedValue(fakeUsageResult);
  });

  it("passes period, project, and source query params through to getUsage", async () => {
    const req = makeGetRequest({ period: "7d", project: "my-app", source: "claude" });

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(getUsage).toHaveBeenCalledWith("7d", "my-app", "claude", undefined);
  });

  it("forwards the home param (normalized) to getUsage (#311)", async () => {
    // Pre-normalized key passes through unchanged on every platform.
    const req = makeGetRequest({ period: "7d", project: "my-app", home: "//wsl.localhost/ubuntu/home/me/.claude" });

    await GET(req);

    expect(getUsage).toHaveBeenCalledWith(
      "7d",
      "my-app",
      undefined,
      "//wsl.localhost/ubuntu/home/me/.claude"
    );
  });

  it("caches per home — two homes never share a slot (#311)", async () => {
    await GET(makeGetRequest({ period: "7d", home: "//wsl.localhost/ubuntu/home/me/.claude" }));
    await GET(makeGetRequest({ period: "7d", home: "//wsl.localhost/debian/home/me/.claude" }));
    // Same period, different home → two distinct getUsage calls, and the
    // ETags must differ (home rides in the ETag parts).
    expect(getUsage).toHaveBeenCalledTimes(2);

    await GET(makeGetRequest({ period: "7d", home: "//wsl.localhost/ubuntu/home/me/.claude" }));
    await GET(makeGetRequest({ period: "7d", home: "//wsl.localhost/debian/home/me/.claude" }));
    // Third + fourth calls hit the cache (still 2 getUsage calls)...
    expect(getUsage).toHaveBeenCalledTimes(2);
    // ...and the home rides in the ETag parts so client 304s can't cross homes
    // (computeETag itself is mocked — assert on its inputs).
    const partsSeen = vi
      .mocked(computeETag)
      .mock.calls.map((c) => (c[0] as { parts: string[] }).parts);
    expect(partsSeen.some((p) => p.includes("//wsl.localhost/ubuntu/home/me/.claude"))).toBe(true);
    expect(partsSeen.some((p) => p.includes("//wsl.localhost/debian/home/me/.claude"))).toBe(true);
  });

  it("defaults period to '30d' when the param is absent", async () => {
    const req = makeGetRequest({});

    await GET(req);

    // Absent param: params.get("period") is null → (null || "30d") → validatePeriod("30d") → "30d"
    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined, undefined);
  });

  it("normalizes the legacy alias 'week' to '7d'", async () => {
    const req = makeGetRequest({ period: "week" });

    await GET(req);

    expect(getUsage).toHaveBeenCalledWith("7d", undefined, undefined, undefined);
  });

  it("normalizes the legacy alias 'month' to '30d'", async () => {
    const req = makeGetRequest({ period: "month" });

    await GET(req);

    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined, undefined);
  });

  it("defaults an invalid period value to '30d'", async () => {
    const req = makeGetRequest({ period: "banana" });
    await GET(req);
    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined, undefined);
  });

  it("treats ?period=__proto__ as invalid and defaults to '30d'", async () => {
    const req = makeGetRequest({ period: "__proto__" });
    await GET(req);
    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined, undefined);
  });

  it("returns the usage report body in the response", async () => {
    const req = makeGetRequest({ period: "all" });

    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalTokens: 42_000, totalCost: 0.42 });
  });
});
