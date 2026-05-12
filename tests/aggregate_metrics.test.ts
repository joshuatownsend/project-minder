import { describe, it, expect, vi, beforeEach } from "vitest";

// All three data source modules + metrics cache get mocked so we can
// test the aggregator's wiring without touching fs, network, or caches.

vi.mock("@/lib/liveStatus", () => ({
  getLiveStatusPayload: vi.fn().mockResolvedValue({ sessions: [] }),
}));

vi.mock("@/lib/hooks/buffer", () => ({
  sweepAndGetState: vi.fn(() => ({ liveSlugs: [], awaitingSlugs: [] })),
  getHookBuffer: vi.fn(() => []),
  STOP_EVENTS: new Set(["Stop", "SessionEnd"]),
}));

vi.mock("@/lib/agentView/jobRoster", () => ({
  getRosterEntries: vi.fn(() => []),
}));

vi.mock("@/lib/agentView/liveCostCache", () => ({
  getLiveSessionMetrics: vi.fn(),
}));

import { getLiveStatusPayload } from "@/lib/liveStatus";
import { getRosterEntries } from "@/lib/agentView/jobRoster";
import { getLiveSessionMetrics } from "@/lib/agentView/liveCostCache";
import { aggregateLiveSessions } from "@/lib/agentView/aggregate";

const mockGetLiveStatus = vi.mocked(getLiveStatusPayload);
const mockGetRoster = vi.mocked(getRosterEntries);
const mockGetMetrics = vi.mocked(getLiveSessionMetrics);

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

function jsonlSession(sessionId: string, status: "working" | "approval" | "other" = "working") {
  return {
    sessionId,
    projectSlug: "test-proj",
    projectName: "test proj",
    status,
    mtime: new Date(NOW - 30_000).toISOString(),
    lastToolName: "Bash",
  };
}

function rosterEntry(sessionId: string, state = "working") {
  return {
    id: sessionId,
    sessionId,
    projectSlug: "test-proj",
    state,
    updatedAt: new Date(NOW - 30_000).toISOString(),
    processRunning: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW);
  mockGetMetrics.mockResolvedValue({ totalCostUsd: 0.042, contextFill: 0.67 });
});

describe("aggregateLiveSessions — metrics wiring", () => {
  describe("JSONL-only path", () => {
    it("populates costEstimate and maxContextFill for working sessions", async () => {
      mockGetLiveStatus.mockResolvedValue({ generatedAt: new Date(NOW).toISOString(), sessions: [jsonlSession("s1", "working")] });
      mockGetRoster.mockReturnValue([]);

      const result = await aggregateLiveSessions();
      const session = result.find((s) => s.sessionId === "s1");
      expect(session).toBeDefined();
      expect(session?.costEstimate).toBeCloseTo(0.042, 5);
      expect(session?.maxContextFill).toBeCloseTo(0.67, 5);
    });

    it("does not call getLiveSessionMetrics for old idle sessions (filtered out)", async () => {
      const oldIdleSession = {
        ...jsonlSession("s2", "other"),
        mtime: new Date(NOW - 600_000).toISOString(), // 10 min ago
      };
      mockGetLiveStatus.mockResolvedValue({ generatedAt: new Date(NOW).toISOString(), sessions: [oldIdleSession] });
      mockGetRoster.mockReturnValue([]);

      await aggregateLiveSessions();
      // Old idle sessions are dropped before enrichment
      expect(mockGetMetrics).not.toHaveBeenCalledWith("s2");
    });
  });

  describe("daemon roster path", () => {
    it("populates cost for working roster sessions", async () => {
      mockGetLiveStatus.mockResolvedValue({ generatedAt: new Date(NOW).toISOString(), sessions: [] });
      mockGetRoster.mockReturnValue([rosterEntry("s3", "working")]);

      const result = await aggregateLiveSessions();
      const session = result.find((s) => s.sessionId === "s3");
      expect(session?.costEstimate).toBeCloseTo(0.042, 5);
      expect(session?.maxContextFill).toBeCloseTo(0.67, 5);
    });

    it("skips cost enrichment for terminal roster sessions", async () => {
      mockGetLiveStatus.mockResolvedValue({ generatedAt: new Date(NOW).toISOString(), sessions: [] });
      mockGetRoster.mockReturnValue([rosterEntry("s4", "completed")]);

      await aggregateLiveSessions();
      expect(mockGetMetrics).not.toHaveBeenCalledWith("s4");
    });
  });

  describe("when getLiveSessionMetrics returns null", () => {
    it("leaves costEstimate and maxContextFill undefined", async () => {
      mockGetMetrics.mockResolvedValue(null);
      mockGetLiveStatus.mockResolvedValue({ generatedAt: new Date(NOW).toISOString(), sessions: [jsonlSession("s5", "working")] });
      mockGetRoster.mockReturnValue([]);

      const result = await aggregateLiveSessions();
      const session = result.find((s) => s.sessionId === "s5");
      expect(session?.costEstimate).toBeUndefined();
      expect(session?.maxContextFill).toBeUndefined();
    });
  });
});
