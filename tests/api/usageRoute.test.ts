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
import { GET } from "@/app/api/usage/route";
import type { UsageReport } from "@/lib/usage/types";

/** Clear the route-level cache stored on globalThis between tests.
 *
 * The route initializes `globalThis.__usageCache` at module load time
 * (`if (!globalForUsage.__usageCache) { ... = new Map() }`), so the
 * guard only runs once per module lifetime. After that, the Map lives
 * on globalThis for the duration of the test run. We reset it to a fresh
 * Map (rather than deleting the key) so the route's `cache.get()` still
 * has a valid Map to work with.
 */
function clearUsageRouteCache() {
  const g = globalThis as Record<string, unknown>;
  g.__usageCache = new Map();
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
    expect(getUsage).toHaveBeenCalledWith("7d", "my-app", "claude");
  });

  it("defaults period to '30d' when the param is absent", async () => {
    const req = makeGetRequest({});

    await GET(req);

    // validatePeriod("") returns "30d"
    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined);
  });

  it("normalizes the legacy alias 'week' to '7d'", async () => {
    const req = makeGetRequest({ period: "week" });

    await GET(req);

    expect(getUsage).toHaveBeenCalledWith("7d", undefined, undefined);
  });

  it("normalizes the legacy alias 'month' to '30d'", async () => {
    const req = makeGetRequest({ period: "month" });

    await GET(req);

    expect(getUsage).toHaveBeenCalledWith("30d", undefined, undefined);
  });

  it("returns the usage report body in the response", async () => {
    const req = makeGetRequest({ period: "all" });

    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totalTokens: 42_000, totalCost: 0.42 });
  });
});
