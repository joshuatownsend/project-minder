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
import path from "path";

// Platform-appropriate scan-root fixtures. `validateProjectPath` in the route
// uses POSIX `path.resolve`/`path.sep` on Linux CI (ubuntu-latest) and win32
// semantics on Windows, so a hard-coded `C:\dev\...` fixture only validates on
// Windows and 403s on CI. Derive both the root and the in/out-of-root paths
// from the current platform so the success cases resolve consistently on both.
const ROOT = process.platform === "win32" ? "C:\\dev" : "/dev";
const INSIDE_ROOT = path.join(ROOT, "my-app");
const OUTSIDE_ROOT =
  process.platform === "win32" ? "C:\\other\\outside-root" : "/other/outside-root";

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

vi.mock("@/lib/config", () => {
  // Hoisted factory — can't reference the module-scope ROOT const, so recompute
  // the platform-appropriate root here (see the ROOT comment above).
  const root = process.platform === "win32" ? "C:\\dev" : "/dev";
  return {
    readConfig: vi.fn(async () => ({
      statuses: {},
      hidden: [],
      portOverrides: {},
      devRoot: root,
      devRoots: [root],
      pinnedSlugs: [],
    })),
    getDevRoots: vi.fn((config: { devRoots?: string[]; devRoot?: string }) =>
      config.devRoots ?? [config.devRoot ?? root]
    ),
  };
});

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

/**
 * Same as makePostRequest, but stubs `.json()` to resolve with the exact
 * object given rather than round-tripping through JSON.stringify/parse. This
 * is purely a unit-test seam: it lets us hand the route's parsed body a JS
 * value that JSON can't carry on the wire (e.g. `NaN`, which `JSON.stringify`
 * turns into `null`), so the route's runtime `isValidPort` guard is exercised
 * directly against that value. It is not claiming a real HTTP client could
 * deliver `NaN` — it's isolating the validation branch from the transport.
 */
function makePostRequestRaw(
  slug: string,
  body: Record<string, unknown>
): [NextRequest, { params: Promise<{ slug: string }> }] {
  const [req, params] = makePostRequest(slug, {});
  req.json = vi.fn().mockResolvedValue(body);
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
      projectPath: OUTSIDE_ROOT,
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

/**
 * S2 — runtime port validation.
 *
 * `port` is typed `number` in the route but arrives as unvalidated JSON at
 * runtime; it flows into processManager.start/restart -> String(portOverride)
 * -> spawn args. These tests assert the route rejects anything that isn't a
 * plausible TCP port (400) before processManager is ever called, and that a
 * genuinely valid port passes through untouched.
 */
describe("POST /api/dev-server/[slug] — port validation (S2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const invalidPorts: Array<[string, unknown]> = [
    ["0", 0],
    ["70000 (out of range)", 70000],
    ['"4100&calc" (string, injection attempt)', "4100&calc"],
    ["3.5 (non-integer)", 3.5],
    ["NaN", NaN],
  ];

  for (const [label, port] of invalidPorts) {
    it(`rejects action:"start" with an invalid port: ${label}`, async () => {
      const [req, params] = makePostRequestRaw("my-app", {
        action: "start",
        projectPath: INSIDE_ROOT,
        port,
      });

      const res = await POST(req, params);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: "port must be an integer 1-65535" });
      expect(processManager.start).not.toHaveBeenCalled();
    });

    it(`rejects action:"restart" with an invalid port: ${label}`, async () => {
      const [req, params] = makePostRequestRaw("my-app", {
        action: "restart",
        projectPath: INSIDE_ROOT,
        port,
      });

      const res = await POST(req, params);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: "port must be an integer 1-65535" });
      expect(processManager.restart).not.toHaveBeenCalled();
    });
  }

  it('accepts action:"start" with a valid port (4100) and passes it through', async () => {
    vi.mocked(processManager.start).mockResolvedValue({
      slug: "my-app",
      projectPath: INSIDE_ROOT,
      pid: 123,
      port: 4100,
      command: "next dev --port 4100",
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    });

    const [req, params] = makePostRequest("my-app", {
      action: "start",
      projectPath: INSIDE_ROOT,
      port: 4100,
    });

    const res = await POST(req, params);

    expect(res.status).toBe(200);
    expect(processManager.start).toHaveBeenCalledWith("my-app", INSIDE_ROOT, 4100);
  });

  it('allows action:"start" with no port at all (undefined passes through)', async () => {
    vi.mocked(processManager.start).mockResolvedValue({
      slug: "my-app",
      projectPath: INSIDE_ROOT,
      pid: 123,
      command: "next dev --port 3000",
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    });

    const [req, params] = makePostRequest("my-app", {
      action: "start",
      projectPath: INSIDE_ROOT,
    });

    const res = await POST(req, params);

    expect(res.status).toBe(200);
    expect(processManager.start).toHaveBeenCalledWith("my-app", INSIDE_ROOT, undefined);
  });
});
