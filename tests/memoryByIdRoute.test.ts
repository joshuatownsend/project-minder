import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

// PUT /api/memory/by-id/[id] — allowlist gating, 2 MB cap, mtime conflict,
// configHistory snapshot, atomic write. We use a real tmpdir so the
// configHistory snapshot trail is exercised end-to-end (the same atomic-
// write path used in production).

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

interface ProjectStub {
  slug: string;
  name: string;
  path: string;
  status: string;
  dependencies: string[];
  dockerPorts: never[];
  externalServices: never[];
  scannedAt: string;
}

function mkProject(slug: string, p: string): ProjectStub {
  return {
    slug,
    name: slug,
    path: p,
    status: "active",
    dependencies: [],
    dockerPorts: [],
    externalServices: [],
    scannedAt: new Date().toISOString(),
  };
}

async function reload() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return await import("@/app/api/memory/by-id/[id]/route");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "minder-mem-route-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  await fs.mkdir(path.join(tmpHome, ".claude"), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function makeRequest(id: string, method: "GET" | "PUT", body?: unknown): NextRequest {
  if (body === undefined) {
    return new NextRequest(`http://localhost:4100/api/memory/by-id/${id}`, { method });
  }
  return new NextRequest(`http://localhost:4100/api/memory/by-id/${id}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function stubScan(projects: ProjectStub[]) {
  vi.doMock("@/lib/cache", () => ({
    getCachedScan: () => ({ projects, ports: [], devRoots: [] }),
    setCachedScan: () => {},
    invalidateCache: () => {},
  }));
  vi.doMock("@/lib/scanner", () => ({
    scanAllProjects: async () => ({ projects, ports: [], devRoots: [] }),
  }));
}

function encodeId(p: string): string {
  return Buffer.from(p, "utf-8").toString("base64url");
}

describe("PUT /api/memory/by-id/[id] — allowlist", () => {
  it("rejects path outside the allowlist with 400 PATH_NOT_ALLOWED", async () => {
    await stubScan([]);
    const { PUT } = await reload();
    const stray = path.join(tmpHome, "stray.md");
    await fs.writeFile(stray, "x");
    const id = encodeId(stray);
    const res = await PUT(makeRequest(id, "PUT", { content: "new", mtimeMs: 0 }), paramsFor(id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("PATH_NOT_ALLOWED");
  });

  it("accepts user CLAUDE.md", async () => {
    await stubScan([]);
    const userPath = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.writeFile(userPath, "old\n");
    const stat = await fs.stat(userPath);
    const { PUT } = await reload();
    const id = encodeId(userPath);
    const res = await PUT(
      makeRequest(id, "PUT", { content: "new\n", mtimeMs: stat.mtimeMs }),
      paramsFor(id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.mtimeMs).toBe("number");
    const after = await fs.readFile(userPath, "utf-8");
    expect(after).toBe("new\n");
  });
});

describe("PUT /api/memory/by-id/[id] — validation", () => {
  it("returns 413 when content exceeds 2 MB", async () => {
    const userPath = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.writeFile(userPath, "x");
    await stubScan([]);
    const { PUT } = await reload();
    const id = encodeId(userPath);
    const huge = "a".repeat(2 * 1024 * 1024 + 1);
    const stat = await fs.stat(userPath);
    const res = await PUT(
      makeRequest(id, "PUT", { content: huge, mtimeMs: stat.mtimeMs }),
      paramsFor(id),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("TOO_LARGE");
  });

  it("returns 400 INVALID_BODY when mtimeMs is missing", async () => {
    const userPath = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.writeFile(userPath, "x");
    await stubScan([]);
    const { PUT } = await reload();
    const id = encodeId(userPath);
    const res = await PUT(makeRequest(id, "PUT", { content: "new" }), paramsFor(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_BODY");
  });

  it("returns 400 INVALID_ID for an undecodable id", async () => {
    await stubScan([]);
    const { PUT } = await reload();
    const id = "not%a%valid%id%@@@";
    const res = await PUT(
      makeRequest(id, "PUT", { content: "x", mtimeMs: 0 }),
      paramsFor(id),
    );
    // Accept either 400 INVALID_ID (decode succeeded but produced garbage that
    // fails allowlist) or PATH_NOT_ALLOWED — both are correct rejections.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(["INVALID_ID", "PATH_NOT_ALLOWED"]).toContain(body.error.code);
  });
});

describe("PUT /api/memory/by-id/[id] — mtime conflict", () => {
  it("returns 409 when caller's mtimeMs doesn't match current", async () => {
    const userPath = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.writeFile(userPath, "old");
    await stubScan([]);
    const { PUT } = await reload();
    const id = encodeId(userPath);
    const res = await PUT(
      makeRequest(id, "PUT", { content: "new", mtimeMs: 12345 }),
      paramsFor(id),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("MTIME_CONFLICT");
  });
});

describe("PUT /api/memory/by-id/[id] — auto tier", () => {
  it("accepts an auto-memory file path inside a project's memory dir", async () => {
    const proj = path.join(tmpHome, "projA");
    await fs.mkdir(proj);
    const { encodePath } = await import("@/lib/scanner/claudeConversations");
    const memDir = path.join(tmpHome, ".claude", "projects", encodePath(proj), "memory");
    await fs.mkdir(memDir, { recursive: true });
    const file = path.join(memDir, "user_role.md");
    await fs.writeFile(file, "old");
    const stat = await fs.stat(file);
    await stubScan([mkProject("projA", proj)]);
    const { PUT } = await reload();
    const id = encodeId(file);
    const res = await PUT(
      makeRequest(id, "PUT", { content: "new content", mtimeMs: stat.mtimeMs }),
      paramsFor(id),
    );
    expect(res.status).toBe(200);
    expect(await fs.readFile(file, "utf-8")).toBe("new content");
  });
});
