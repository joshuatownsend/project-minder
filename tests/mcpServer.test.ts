import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServerForTests } from "@/lib/mcp/server";

/**
 * Smoke tests for the MCP server. Each test wires up a fresh
 * (server, in-memory-transport-pair, client) so registered handlers are
 * exercised end-to-end via the SDK Client API — same code path Claude
 * Desktop / Claude Code take over HTTP, minus the wire transport.
 *
 * Real lib functions are NOT mocked: tools call into scanner/usage/db
 * exactly as they would in production. The fixtures here just confirm
 * the MCP handshake completes, every tool/resource is discoverable, and
 * a few representative reads return well-shaped payloads.
 */

async function makeConnectedClient() {
  const server = await buildMcpServerForTests();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP server boot", () => {
  let tools: { name: string }[] = [];
  let resourceTemplates: { uriTemplate: string }[] = [];
  let staticResources: { uri: string }[] = [];

  // 120s hookTimeout — the in-memory transport + Zod schema parse for ~45 tools
  // takes a few seconds in isolation, but under 8-worker vitest contention can
  // blow the 10s default. Bumping the hook (not each `it`) is the right knob.
  //
  // Per-call `timeout: 120_000` overrides the MCP SDK's default 60s request
  // timeout (DEFAULT_REQUEST_TIMEOUT_MSEC at
  // node_modules/@modelcontextprotocol/sdk/.../protocol.ts:1216). `listResources()`
  // invokes every registered resource template's `list` callback to enumerate
  // concrete instances — on a machine with hundreds of indexed sessions that
  // single call blows the 60s SDK window even though the vitest hookTimeout
  // is 120s, surfacing as "MCP error -32001: Request timed out" (#158).
  beforeAll(async () => {
    const { client } = await makeConnectedClient();
    tools = (await client.listTools(undefined, { timeout: 120_000 })).tools;
    resourceTemplates = (
      await client.listResourceTemplates(undefined, { timeout: 120_000 })
    ).resourceTemplates;
    staticResources = (await client.listResources(undefined, { timeout: 120_000 })).resources;
  }, 120_000);

  it("exposes the documented tool surface", () => {
    const names = new Set(tools.map((t) => t.name));
    // Project & config
    expect(names.has("list-projects")).toBe(true);
    expect(names.has("get-project")).toBe(true);
    expect(names.has("scan-projects")).toBe(true);
    expect(names.has("get-project-config")).toBe(true);
    expect(names.has("update-project-config")).toBe(true);
    // Usage
    expect(names.has("get-usage")).toBe(true);
    expect(names.has("get-usage-by-day")).toBe(true);
    expect(names.has("get-usage-by-tool")).toBe(true);
    expect(names.has("get-usage-by-category")).toBe(true);
    expect(names.has("get-one-shot-stats")).toBe(true);
    expect(names.has("export-usage")).toBe(true);
    // Sessions
    expect(names.has("list-sessions")).toBe(true);
    expect(names.has("get-session")).toBe(true);
    expect(names.has("search-sessions")).toBe(true);
    // Catalog
    expect(names.has("list-agents")).toBe(true);
    expect(names.has("get-agent")).toBe(true);
    expect(names.has("list-skills")).toBe(true);
    expect(names.has("get-skill")).toBe(true);
    expect(names.has("refresh-catalog")).toBe(true);
    // Manual steps + insights
    expect(names.has("list-manual-steps")).toBe(true);
    expect(names.has("toggle-manual-step")).toBe(true);
    expect(names.has("list-insights")).toBe(true);
    // Git
    expect(names.has("get-git-status")).toBe(true);
    expect(names.has("refresh-git-status")).toBe(true);
    // Stats
    expect(names.has("get-portfolio-stats")).toBe(true);
    expect(names.has("get-efficiency-grades")).toBe(true);
    expect(names.has("get-context-overhead")).toBe(true);
    expect(names.has("get-project-hot-files")).toBe(true);
    // OTEL
    expect(names.has("query-otel-events")).toBe(true);
    expect(names.has("query-otel-metrics")).toBe(true);
    expect(names.has("get-tool-latency")).toBe(true);
    expect(names.has("get-cache-efficiency")).toBe(true);
    expect(names.has("get-context-pressure")).toBe(true);
    // Dev servers
    expect(names.has("list-dev-servers")).toBe(true);
  });

  it("returns at least 30 tools (full surface)", () => {
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it("registers expected resource templates", () => {
    const patterns = resourceTemplates.map((t) => t.uriTemplate);
    expect(patterns).toContain("minder://projects/{slug}");
    expect(patterns).toContain("minder://sessions/{sessionId}");
    expect(patterns).toContain("minder://agents/{id}");
    expect(patterns).toContain("minder://skills/{id}");
    expect(patterns).toContain("minder://usage/{period}");
    expect(patterns).toContain("minder://projects/{slug}/insights");
    expect(patterns).toContain("minder://projects/{slug}/manual-steps");
    expect(patterns).toContain("minder://projects/{slug}/sessions");
  });

  it("registers static resources for config + stats", () => {
    const uris = staticResources.map((r) => r.uri);
    expect(uris).toContain("minder://config");
    expect(uris).toContain("minder://stats");
  });

  it("every tool has a non-empty description", () => {
    const missing = tools
      .map((t) => t as { name: string; description?: string })
      .filter((t) => !t.description || t.description.trim().length === 0);
    expect(missing.map((t) => t.name)).toEqual([]);
  });
});
