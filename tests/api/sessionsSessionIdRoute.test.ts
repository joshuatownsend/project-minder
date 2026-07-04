/**
 * Characterization tests for GET /api/sessions/[sessionId]
 *
 * Thin wrapper over `getSessionDetail` (@/lib/data). Covers:
 *  - Happy path: 200, detail body, X-Minder-Backend header
 *  - Edge: unknown sessionId → detail null → 404 { error }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/data", () => ({
  getSessionDetail: vi.fn(),
}));

import { getSessionDetail } from "@/lib/data";
import { GET } from "@/app/api/sessions/[sessionId]/route";

function req(sessionId: string) {
  return new NextRequest(`http://localhost/api/sessions/${sessionId}`);
}

describe("GET /api/sessions/[sessionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the session detail and backend header", async () => {
    vi.mocked(getSessionDetail).mockResolvedValue({
      detail: { sessionId: "abc-123", timeline: [], fileOps: [] } as unknown as Awaited<
        ReturnType<typeof getSessionDetail>
      >["detail"],
      meta: { backend: "file" },
    });

    const res = await GET(req("abc-123"), {
      params: Promise.resolve({ sessionId: "abc-123" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    const body = await res.json();
    expect(body).toMatchObject({ sessionId: "abc-123" });
  });

  it("returns 404 when the session is not found", async () => {
    vi.mocked(getSessionDetail).mockResolvedValue({
      detail: null,
      meta: { backend: "file" },
    });

    const res = await GET(req("nope"), {
      params: Promise.resolve({ sessionId: "nope" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Session not found" });
  });
});
