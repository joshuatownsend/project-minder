/**
 * Characterization tests for GET /api/git-status
 *
 * Dumb cache reader — no params, just serializes gitStatusCache's current
 * state. Covers:
 *  - Happy path: statuses/pending/total from the cache
 *  - Empty cache → {} / 0 / 0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/gitStatusCache", () => ({
  gitStatusCache: {
    getAll: vi.fn(),
    pending: 0,
    total: 0,
  },
}));

import { gitStatusCache } from "@/lib/gitStatusCache";
import { GET } from "@/app/api/git-status/route";

describe("GET /api/git-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns statuses/pending/total from the cache", async () => {
    vi.mocked(gitStatusCache.getAll).mockReturnValue({
      "my-app": { isDirty: true, uncommittedCount: 3, checkedAt: Date.now() },
    });
    Object.assign(gitStatusCache, { pending: 2, total: 5 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      statuses: { "my-app": { isDirty: true, uncommittedCount: 3 } },
      pending: 2,
      total: 5,
    });
  });

  it("returns an empty shape when the cache is cold", async () => {
    vi.mocked(gitStatusCache.getAll).mockReturnValue({});
    Object.assign(gitStatusCache, { pending: 0, total: 0 });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ statuses: {}, pending: 0, total: 0 });
  });
});
