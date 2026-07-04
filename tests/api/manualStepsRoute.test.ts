/**
 * Characterization tests for GET /api/manual-steps
 *
 * Thin wrapper over `@/lib/server/queries/manualSteps` (`loadManualStepsResponse`).
 * Covers:
 *  - ?pending=true forwarded as the pendingOnly flag
 *  - Absent/other values default to pendingOnly=false
 *  - Empty result → []
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/queries/manualSteps", () => ({
  loadManualStepsResponse: vi.fn(),
}));

import { loadManualStepsResponse } from "@/lib/server/queries/manualSteps";
import { GET } from "@/app/api/manual-steps/route";

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/manual-steps");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/manual-steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes pendingOnly=true when ?pending=true", async () => {
    vi.mocked(loadManualStepsResponse).mockResolvedValue([
      {
        slug: "my-app",
        name: "my-app",
        path: "C:\\dev\\my-app",
        manualSteps: { pendingSteps: 2, entries: [] },
      },
    ] as unknown as Awaited<ReturnType<typeof loadManualStepsResponse>>);

    const res = await GET(makeRequest({ pending: "true" }));

    expect(res.status).toBe(200);
    expect(loadManualStepsResponse).toHaveBeenCalledWith(true);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("defaults pendingOnly to false when the param is absent", async () => {
    vi.mocked(loadManualStepsResponse).mockResolvedValue([]);

    await GET(makeRequest({}));

    expect(loadManualStepsResponse).toHaveBeenCalledWith(false);
  });

  it("treats any non-'true' value as false", async () => {
    vi.mocked(loadManualStepsResponse).mockResolvedValue([]);

    await GET(makeRequest({ pending: "yes" }));

    expect(loadManualStepsResponse).toHaveBeenCalledWith(false);
  });

  it("returns an empty array when no project has manual steps", async () => {
    vi.mocked(loadManualStepsResponse).mockResolvedValue([]);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
