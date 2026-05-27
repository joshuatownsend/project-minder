import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServerForTests } from "@/lib/mcp/server";
import { setCachedScan, invalidateCache } from "@/lib/cache";

// Isolation hooks (#173). Three independent leak sources combined into one
// setup block — without them the MCP tests walk the developer's real
// filesystem and routinely exceed the SDK request timeout:
//
// 1. `~/.claude/projects/` — `minder://usage/7d`, `get-usage-by-day`,
//    `minder://stats` (indirectly). Mitigated by HOME/USERPROFILE
//    override + `os.homedir` spy + empty tmp `.claude/projects/`.
// 2. `devRoot` (default `C:\dev` on Windows) — `list-projects`,
//    `minder://stats`, every resource template that builds project URIs.
//    Mitigated by pre-populating the scan cache with an empty
//    `ScanResult` so `getCachedOrFreshScan` returns immediately without
//    invoking `scanAllProjects()`. The cache lives on globalThis with a
//    5-min TTL.
// 3. Cache bleed between test runs — `afterEach` invalidates so other
//    files' tests don't see our empty-projects snapshot.
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-mcp-resources-"));
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

async function client() {
  const server = await buildMcpServerForTests();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: "test", version: "0" });
  await cl.connect(c);
  return cl;
}

function parseJsonContent<T = unknown>(result: {
  contents: Array<{ mimeType?: string; text?: string }>;
}): T {
  const block = result.contents[0];
  expect(block?.mimeType).toBe("application/json");
  expect(block?.text).toBeDefined();
  return JSON.parse(block!.text!) as T;
}

describe("static MCP resources", () => {
  it("minder://config returns parsed config", async () => {
    const cl = await client();
    const result = await cl.readResource({ uri: "minder://config" });
    const config = parseJsonContent<Record<string, unknown>>(
      result as Parameters<typeof parseJsonContent>[0]
    );
    expect(config).toHaveProperty("statuses");
    expect(config).toHaveProperty("hidden");
  });

  it("minder://stats returns a stats payload with backend label", async () => {
    const cl = await client();
    // Per-call SDK timeout overrides the 60s default — the stats aggregator
    // walks every session JSONL when the SQLite index isn't enabled; under
    // vitest worker contention this blows the SDK window even though the
    // test-level budget is 120s (#158).
    const result = await cl.readResource(
      { uri: "minder://stats" },
      { timeout: 120_000 },
    );
    const payload = parseJsonContent<{ backend: string; stats: unknown }>(
      result as Parameters<typeof parseJsonContent>[0]
    );
    expect(["db", "file"]).toContain(payload.backend);
    expect(payload.stats).toBeDefined();
  }, 120_000);
});

describe("template MCP resources", () => {
  it("project listing returns minder://projects/{slug} URIs", async () => {
    const cl = await client();
    // listResources only lists the top-level static + templates' list callbacks.
    // We need the template listing surface.
    const templates = await cl.listResourceTemplates();
    const projectTpl = templates.resourceTemplates.find(
      (t) => t.uriTemplate === "minder://projects/{slug}"
    );
    expect(projectTpl).toBeDefined();
    expect(projectTpl?.name).toBe("project");
  });

  // 90s timeout — `getUsage` parses every JSONL session in ~/.claude/projects/
  // when the SQLite index isn't enabled. Under 8-worker vitest contention this
  // can blow the default 30s budget on a machine with hundreds of sessions; in
  // isolation it's well under 5s.
  it(
    "minder://usage/7d returns a usage report wrapped with backend label",
    async () => {
      const cl = await client();
      // Per-call SDK timeout — same rationale as the `minder://stats` test
      // above (#158). The usage aggregator scans every session JSONL on
      // cold cache; under contention this can exceed the 60s SDK default.
      const result = await cl.readResource(
        { uri: "minder://usage/7d" },
        { timeout: 120_000 },
      );
      const payload = parseJsonContent<{ backend: string; report: { period: string } }>(
        result as Parameters<typeof parseJsonContent>[0]
      );
      expect(["db", "file"]).toContain(payload.backend);
      expect(payload.report).toHaveProperty("period");
    },
    120_000
  );

  it("unknown session id returns an error-shaped JSON payload (not a transport error)", async () => {
    const cl = await client();
    const result = await cl.readResource({
      uri: "minder://sessions/definitely-not-a-real-id-zzz",
    });
    const payload = parseJsonContent<Record<string, unknown>>(
      result as Parameters<typeof parseJsonContent>[0]
    );
    // Either { error: "..." } or backend+detail null — both valid.
    expect(payload.error !== undefined || payload.detail !== undefined).toBe(true);
  });
});
