/**
 * Characterization tests for GET /api/github-activity
 *
 * Dumb cache reader mirroring gitStatusRoute — no params, serializes
 * githubActivityCache's current state. Covers:
 *  - Happy path: statuses/pending/total from the cache
 *  - Empty cache (nothing enqueued yet) → {} / 0 / 0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/githubActivityCache", () => ({
  githubActivityCache: {
    getAll: vi.fn(),
    pending: 0,
    total: 0,
  },
}));

import { githubActivityCache } from "@/lib/githubActivityCache";
import { GET } from "@/app/api/github-activity/route";

describe("GET /api/github-activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns statuses/pending/total from the cache", async () => {
    vi.mocked(githubActivityCache.getAll).mockReturnValue({
      "my-app": {
        available: true,
        repo: "o/my-app",
        openPrCount: 2,
        prs: [],
        ci: { status: "passing" },
        checkedAt: Date.now(),
      },
    });
    Object.assign(githubActivityCache, { pending: 1, total: 4 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      statuses: { "my-app": { available: true, openPrCount: 2 } },
      pending: 1,
      total: 4,
    });
  });

  it("returns an empty shape before anything has been enqueued", async () => {
    vi.mocked(githubActivityCache.getAll).mockReturnValue({});
    Object.assign(githubActivityCache, { pending: 0, total: 0 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ statuses: {}, pending: 0, total: 0 });
  });
});
