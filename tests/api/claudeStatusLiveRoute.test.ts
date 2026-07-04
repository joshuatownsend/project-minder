/**
 * Characterization tests for GET /api/claude-status/live (PR #256 review).
 *
 * The consolidated ClaudeStatusProvider drives both the incident banner and the
 * toast listener from this one route. Covers:
 *  - flag off  → { disabled:true, snapshot:null, changes:[] } (no cache reads)
 *  - flag on, no `since`  → snapshot + empty changes (getChanges not called)
 *  - flag on, with `since` → changes filtered by the cursor
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock lib boundaries BEFORE importing the route.
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

vi.mock("@/lib/featureFlags", () => ({
  getFlag: vi.fn(),
}));

vi.mock("@/lib/claudeStatus/cache", () => ({
  getCurrentStatus: vi.fn(),
  getChanges: vi.fn(),
}));

import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getCurrentStatus, getChanges } from "@/lib/claudeStatus/cache";
import { GET } from "@/app/api/claude-status/live/route";

function makeRequest(url = "http://localhost:4100/api/claude-status/live"): NextRequest {
  return new NextRequest(url);
}

describe("GET /api/claude-status/live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readConfig).mockResolvedValue({ featureFlags: {} } as never);
  });

  it("returns the disabled sentinel when claudeStatusAlerts is off (no cache reads)", async () => {
    vi.mocked(getFlag).mockReturnValue(false);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body).toEqual({ disabled: true, snapshot: null, changes: [] });
    expect(getCurrentStatus).not.toHaveBeenCalled();
    expect(getChanges).not.toHaveBeenCalled();
  });

  it("returns the snapshot with empty changes when on and no `since` cursor", async () => {
    vi.mocked(getFlag).mockReturnValue(true);
    const snapshot = { status: "operational", source: "live" };
    vi.mocked(getCurrentStatus).mockResolvedValue(snapshot as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.disabled).toBe(false);
    expect(body.snapshot).toEqual(snapshot);
    expect(body.changes).toEqual([]);
    // Without a cursor there is nothing to diff against, so getChanges is skipped.
    expect(getChanges).not.toHaveBeenCalled();
  });

  it("returns changes filtered by the `since` cursor when on", async () => {
    vi.mocked(getFlag).mockReturnValue(true);
    vi.mocked(getCurrentStatus).mockResolvedValue({ status: "operational" } as never);
    const changes = [{ at: "2026-07-04T00:00:00Z", status: "degraded" }];
    vi.mocked(getChanges).mockReturnValue(changes as never);

    const since = "2026-07-03T00:00:00Z";
    const res = await GET(makeRequest(`http://localhost:4100/api/claude-status/live?since=${since}`));
    const body = await res.json();

    expect(getChanges).toHaveBeenCalledWith(since);
    expect(body.changes).toEqual(changes);
    expect(body.disabled).toBe(false);
  });
});
