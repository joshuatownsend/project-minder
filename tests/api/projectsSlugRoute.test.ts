/**
 * Tests for GET /api/projects/[slug]
 *
 * Focus (PR #227 review — Finding 3): the detail route must enqueue GitHub
 * activity the same way the LIST route does, so opening /project/<slug>
 * directly (without first loading the dashboard) populates the activity cache
 * and the strip can appear. Flag-gated, git-tracked projects only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock lib boundaries before importing the route (vi.mock hoisting).
vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn(),
  setCachedScan: vi.fn(),
}));

vi.mock("@/lib/scanner", () => ({
  scanAllProjects: vi.fn(),
}));

vi.mock("@/lib/scanner/git", () => ({
  scanGitDirtyStatus: vi.fn(async () => ({ isDirty: false, uncommittedCount: 0 })),
}));

vi.mock("@/lib/gitStatusCache", () => ({
  gitStatusCache: { set: vi.fn() },
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

import { getCachedScan } from "@/lib/cache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { readConfig } from "@/lib/config";
import { GET } from "@/app/api/projects/[slug]/route";
import { NextRequest } from "next/server";
import type { MinderConfig, ScanResult } from "@/lib/types";

function makeScanResult(withGit = true): ScanResult {
  return {
    projects: [
      {
        slug: "my-app",
        name: "my-app",
        path: "C:\\dev\\my-app",
        status: "active",
        git: withGit
          ? { branch: "main", isDirty: false, uncommittedCount: 0, remoteUrl: "https://github.com/o/my-app" }
          : undefined,
      } as ScanResult["projects"][number],
    ],
    portConflicts: [],
    hiddenCount: 0,
    scannedAt: new Date("2026-06-01T00:00:00Z").toISOString(),
    catalogLintFindings: [],
  };
}

function mockConfig(featureFlags?: MinderConfig["featureFlags"]) {
  vi.mocked(readConfig).mockResolvedValue({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    featureFlags,
  } as MinderConfig);
}

function req() {
  return new NextRequest("http://localhost/api/projects/my-app");
}
const params = { params: Promise.resolve({ slug: "my-app" }) };

describe("GET /api/projects/[slug] — GitHub activity enqueue (PR #227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubActivityCache.get).mockReturnValue(null);
    mockConfig(undefined);
  });

  it("enqueues GitHub activity for a git repo when the flag is default-on", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(true));

    const res = await GET(req(), params);
    expect(res.status).toBe(200);

    expect(githubActivityCache.enqueue).toHaveBeenCalledTimes(1);
    const items = vi.mocked(githubActivityCache.enqueue).mock.calls[0][0];
    expect(items).toEqual([
      { slug: "my-app", path: "C:\\dev\\my-app", remoteUrl: "https://github.com/o/my-app" },
    ]);
  });

  it("enqueues when the flag is explicitly true", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(true));
    mockConfig({ githubActivity: true });

    await GET(req(), params);

    expect(githubActivityCache.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue when the flag is off", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(true));
    mockConfig({ githubActivity: false });

    await GET(req(), params);

    expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
  });

  it("does NOT enqueue for a non-git project", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(false));

    await GET(req(), params);

    expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
  });

  it("skips enqueue when a fresh cache entry already exists", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(true));
    vi.mocked(githubActivityCache.get).mockReturnValue({
      available: true,
      checkedAt: Date.now(),
    });

    await GET(req(), params);

    expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown slug (no enqueue)", async () => {
    vi.mocked(getCachedScan).mockReturnValue(makeScanResult(true));

    const res = await GET(req(), { params: Promise.resolve({ slug: "nope" }) });
    expect(res.status).toBe(404);
    expect(githubActivityCache.enqueue).not.toHaveBeenCalled();
  });
});
