/**
 * Characterization tests for GET /api/projects
 *
 * Covers:
 *  - Cache-hit path: returns cached ScanResult without calling scanAllProjects
 *  - Cache-miss path: runs scanAllProjects once, stores the result, returns it
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the route so vi.mock hoisting works.
vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn(),
  setCachedScan: vi.fn(),
}));

vi.mock("@/lib/scanner", () => ({
  scanAllProjects: vi.fn(),
}));

vi.mock("@/lib/gitStatusCache", () => ({
  gitStatusCache: {
    get: vi.fn(() => null),
    enqueue: vi.fn(),
  },
}));

vi.mock("@/lib/efficiencyGradeCache", () => ({
  efficiencyGradeCache: {
    enqueue: vi.fn(),
  },
}));

vi.mock("@/lib/githubActivityCache", () => ({
  githubActivityCache: {
    get: vi.fn(() => null),
    enqueue: vi.fn(),
  },
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
}));

import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { readConfig } from "@/lib/config";
import { GET } from "@/app/api/projects/route";
import type { MinderConfig, ScanResult } from "@/lib/types";

const fakeScanResult: ScanResult = {
  projects: [
    {
      slug: "my-app",
      name: "my-app",
      path: "C:\\dev\\my-app",
      status: "active",
      git: { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl: "https://github.com/o/my-app" },
    } as ScanResult["projects"][number],
  ],
  portConflicts: [],
  hiddenCount: 0,
  scannedAt: new Date("2026-06-01T00:00:00Z").toISOString(),
  catalogLintFindings: [],
};

function mockConfig(featureFlags?: MinderConfig["featureFlags"]) {
  vi.mocked(readConfig).mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    featureFlags,
  } as MinderConfig);
}

describe("GET /api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubActivityCache.get).mockReturnValue(null);
    mockConfig(undefined);
  });

  it("returns cached result without calling scanAllProjects (cache hit)", async () => {
    vi.mocked(getCachedScan).mockReturnValue(fakeScanResult);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ projects: fakeScanResult.projects });
    expect(scanAllProjects).not.toHaveBeenCalled();
  });

  it("calls scanAllProjects once on cache miss and returns the stored result (cache miss)", async () => {
    // First call (before scan) returns null; second call (after setCachedScan) returns result.
    vi.mocked(getCachedScan)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(fakeScanResult);

    vi.mocked(scanAllProjects).mockResolvedValue(fakeScanResult);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(scanAllProjects).toHaveBeenCalledTimes(1);
    expect(setCachedScan).toHaveBeenCalledWith(fakeScanResult);

    const body = await res.json();
    expect(body).toMatchObject({ projects: fakeScanResult.projects });
  });

  it("returns empty fallback when cache is still null after scan completes", async () => {
    // Both cache reads return null (simulates pathological scan failure edge case)
    vi.mocked(getCachedScan).mockReturnValue(null);
    vi.mocked(scanAllProjects).mockResolvedValue(fakeScanResult);

    const res = await GET();

    // Handler returns the zero-state fallback JSON
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ projects: [] });
  });

  describe("githubActivity flag gating (Portfolio Command Deck — Phase 4)", () => {
    it("enqueues GitHub activity with remoteUrl when the flag is absent (default-on)", async () => {
      vi.mocked(getCachedScan).mockReturnValue(fakeScanResult);
      mockConfig(undefined);

      await GET();

      expect(githubActivityCache.enqueue).toHaveBeenCalledTimes(1);
      const items = vi.mocked(githubActivityCache.enqueue).mock.calls[0][0];
      expect(items).toEqual([
        { slug: "my-app", path: "C:\\dev\\my-app", remoteUrl: "https://github.com/o/my-app" },
      ]);
    });

    it("enqueues GitHub activity when the flag is explicitly true", async () => {
      vi.mocked(getCachedScan).mockReturnValue(fakeScanResult);
      mockConfig({ githubActivity: true });

      await GET();

      expect(githubActivityCache.enqueue).toHaveBeenCalledTimes(1);
    });

    it("does NOT enqueue GitHub activity when the flag is off", async () => {
      vi.mocked(getCachedScan).mockReturnValue(fakeScanResult);
      mockConfig({ githubActivity: false });

      await GET();

      expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
    });

    it("skips projects whose GitHub activity cache entry is still fresh", async () => {
      vi.mocked(getCachedScan).mockReturnValue(fakeScanResult);
      mockConfig(undefined);
      // A fresh cache entry exists → no re-enqueue.
      vi.mocked(githubActivityCache.get).mockReturnValue({
        available: true,
        checkedAt: Date.now(),
      });

      await GET();

      expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
    });
  });
});
