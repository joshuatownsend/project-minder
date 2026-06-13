/**
 * Characterization tests for POST /api/dev-server/[slug]
 *
 * Covers:
 *  - action:"start" with no projectPath → 400
 *  - action:"start" with projectPath outside configured roots → 403
 *  - action:"stop" → calls processManager.stop and returns its info (200)
 *
 * NOTE: Plan 004 is included in main, so stop() is now async (Promise<DevServerInfo | undefined>).
 * The mock is kept synchronous deliberately — awaiting a non-thenable returns it unchanged,
 * so the route's `await processManager.stop(slug)` still resolves to the plain object.
 * The `as unknown as ReturnType<…>` cast below bridges the synchronous mock value to the async type.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock lib boundaries BEFORE importing the route.

vi.mock("@/lib/processManager", () => ({
  processManager: {
    get: vi.fn(),
    start: vi.fn(),
    // stop() is async in main (plan 004). The mock returns a plain object synchronously;
    // the route's `await processManager.stop(slug)` resolves it unchanged (awaiting a
    // non-thenable is a no-op). The cast uses `as unknown as` to satisfy TypeScript.
    stop: vi.fn(() => ({ status: "stopped", slug: "my-app" })),
    restart: vi.fn(),
  },
}));

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(async () => ({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: "C:\\dev",
    devRoots: ["C:\\dev"],
    pinnedSlugs: [],
  })),
  getDevRoots: vi.fn((config: { devRoots?: string[]; devRoot?: string }) =>
    config.devRoots ?? [config.devRoot ?? "C:\\dev"]
  ),
}));

import { processManager } from "@/lib/processManager";
import { POST } from "@/app/api/dev-server/[slug]/route";

/** Build a NextRequest with a JSON body for the dev-server POST endpoint. */
function makePostRequest(
  slug: string,
  body: Record<string, unknown>
): [NextRequest, { params: Promise<{ slug: string }> }] {
  const req = new NextRequest(
    `http://localhost/api/dev-server/${slug}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const params = { params: Promise.resolve({ slug }) };
  return [req, params];
}

describe("POST /api/dev-server/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset stop mock to default synchronous implementation (see plan 004 note above)
    vi.mocked(processManager.stop).mockImplementation(
      () => ({ status: "stopped", slug: "my-app" }) as unknown as ReturnType<typeof processManager.stop>
    );
  });

  it('returns 400 when action is "start" but projectPath is missing', async () => {
    const [req, params] = makePostRequest("my-app", { action: "start" });

    const res = await POST(req, params);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "projectPath required" });
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it('returns 403 when action is "start" with a projectPath outside configured roots', async () => {
    const [req, params] = makePostRequest("my-app", {
      action: "start",
      projectPath: "C:\\other\\outside-root",
    });

    const res = await POST(req, params);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringContaining("scan roots") });
    expect(processManager.start).not.toHaveBeenCalled();
  });

  it('returns 200 and calls processManager.stop when action is "stop"', async () => {
    const stopResult = { status: "stopped", slug: "my-app" };
    vi.mocked(processManager.stop).mockImplementation(
      () => stopResult as unknown as ReturnType<typeof processManager.stop>
    );

    const [req, params] = makePostRequest("my-app", { action: "stop" });

    const res = await POST(req, params);

    expect(res.status).toBe(200);
    expect(processManager.stop).toHaveBeenCalledWith("my-app");
    const body = await res.json();
    expect(body).toMatchObject({ status: "stopped", slug: "my-app" });
  });
});
