import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServerForTests } from "@/lib/mcp/server";
import { setCachedScan, invalidateCache } from "@/lib/cache";

// Isolation hooks (#173). See mcpResources.test.ts for the full rationale:
// HOME/USERPROFILE override + `os.homedir` spy isolates the JSONL walk;
// pre-populating the scan cache short-circuits the `getCachedOrFreshScan`
// → `scanAllProjects` walk of the configured devRoot (`C:\dev` on
// Windows by default).
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-mcp-tools-"));
  await fs.mkdir(path.join(tmpHome, ".claude", "projects"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  setCachedScan({
    projects: [],
    portConflicts: [],
    hiddenCount: 0,
    scannedAt: new Date().toISOString(),
    catalogLintFindings: [],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  invalidateCache();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// End-to-end tool execution tests. Each call() goes through the real MCP
// JSON-RPC pipe (in-memory transport) → server's registered handler → lib
// functions. The lib functions read the real filesystem and SQLite DB at
// ~/.minder/ — assertions are kept loose enough that empty-state machines
// (no projects, no sessions) still pass.

async function client() {
  const server = await buildMcpServerForTests();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "test", version: "0" });
  await cl.connect(c);
  return cl;
}

function parseText<T = unknown>(result: { content: Array<{ type: string; text?: string }> }): T {
  const block = result.content.find((c) => c.type === "text");
  expect(block?.text).toBeDefined();
  return JSON.parse(block!.text!) as T;
}

describe("get-project-config tool", () => {
  it("returns a config object with the documented MinderConfig fields", async () => {
    const cl = await client();
    const result = await cl.callTool({ name: "get-project-config", arguments: {} });
    const config = parseText<Record<string, unknown>>(result as Parameters<typeof parseText>[0]);
    // Defaults if no .minder.json is present.
    expect(config).toHaveProperty("statuses");
    expect(config).toHaveProperty("hidden");
    expect(config).toHaveProperty("portOverrides");
    expect(config).toHaveProperty("devRoot");
  });
});

describe("list-projects tool", () => {
  it("returns an array of projects with at minimum slug/name/path", async () => {
    const cl = await client();
    // Per-call SDK timeout overrides the 60s default — `list-projects` cold-
    // scans `C:\dev\*` which can run 30–90s on a machine with many projects;
    // the test-level 120s budget covers it, but the SDK's request layer
    // bails earlier without an explicit override (#158).
    const result = await cl.callTool(
      { name: "list-projects", arguments: {} },
      undefined,
      { timeout: 120_000 },
    );
    const payload = parseText<{ projects: unknown[]; total: number }>(
      result as Parameters<typeof parseText>[0]
    );
    expect(Array.isArray(payload.projects)).toBe(true);
    expect(payload.total).toBe(payload.projects.length);
    if (payload.projects.length > 0) {
      const first = payload.projects[0] as Record<string, unknown>;
      expect(typeof first.slug).toBe("string");
      expect(typeof first.name).toBe("string");
      expect(typeof first.path).toBe("string");
    }
  }, 120_000);

  it("rejects an unknown slug from get-project with an error result", async () => {
    const cl = await client();
    const result = await cl.callTool({
      name: "get-project",
      arguments: { slug: "definitely-not-a-real-project-zzz" },
    });
    const r = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No project with slug/);
  });
});

describe("update-project-config tool", () => {
  it("rejects a no-op update", async () => {
    const cl = await client();
    const result = await cl.callTool({
      name: "update-project-config",
      arguments: { slug: "test-slug-no-op" },
    });
    const r = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Nothing to update/);
  });
});

describe("get-git-status tool", () => {
  it("returns the cache shape even when empty", async () => {
    const cl = await client();
    const result = await cl.callTool({ name: "get-git-status", arguments: {} });
    const payload = parseText<{ cached: number; pending: number; statuses: Record<string, unknown> }>(
      result as Parameters<typeof parseText>[0]
    );
    expect(typeof payload.cached).toBe("number");
    expect(typeof payload.pending).toBe("number");
    expect(typeof payload.statuses).toBe("object");
  });
});

describe("get-usage-by-day tool", () => {
  // 120s per-test + per-call SDK timeouts — `get-usage` parses every JSONL
  // session in ~/.claude/projects/ when the SQLite index isn't enabled.
  // Under 8-worker vitest contention this can blow the default 30s budget
  // on a developer machine with hundreds of sessions AND the SDK's 60s
  // request timeout (#158). In isolation it's well under 5s.
  it(
    "returns a daily breakdown for period=7d (possibly empty)",
    async () => {
      const cl = await client();
      const result = await cl.callTool(
        { name: "get-usage-by-day", arguments: { period: "7d" } },
        undefined,
        { timeout: 120_000 },
      );
      const payload = parseText<{ period: string; daily: unknown[] }>(
        result as Parameters<typeof parseText>[0]
      );
      expect(payload.period).toBe("7d");
      expect(Array.isArray(payload.daily)).toBe(true);
    },
    120_000
  );
});

describe("OTEL tools", () => {
  it("query-otel-events returns an events array (possibly empty when DB is cold)", async () => {
    const cl = await client();
    const result = await cl.callTool({
      name: "query-otel-events",
      arguments: { period: "7d", limit: 10 },
    });
    const payload = parseText<{ events: unknown[]; total: number }>(
      result as Parameters<typeof parseText>[0]
    );
    expect(Array.isArray(payload.events)).toBe(true);
    expect(typeof payload.total).toBe("number");
  });

  it("get-tool-latency returns a tools array (possibly empty)", async () => {
    const cl = await client();
    const result = await cl.callTool({
      name: "get-tool-latency",
      arguments: { period: "7d" },
    });
    const payload = parseText<{ tools: unknown[]; hasData: boolean }>(
      result as Parameters<typeof parseText>[0]
    );
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(typeof payload.hasData).toBe("boolean");
  });
});

describe("list-dev-servers tool", () => {
  it("returns a servers array — likely empty in test runs", async () => {
    const cl = await client();
    const result = await cl.callTool({ name: "list-dev-servers", arguments: {} });
    const payload = parseText<{ total: number; servers: unknown[] }>(
      result as Parameters<typeof parseText>[0]
    );
    expect(Array.isArray(payload.servers)).toBe(true);
    expect(payload.total).toBe(payload.servers.length);
  });
});
