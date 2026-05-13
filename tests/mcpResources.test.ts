import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServerForTests } from "@/lib/mcp/server";

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
    const result = await cl.readResource({ uri: "minder://stats" });
    const payload = parseJsonContent<{ backend: string; stats: unknown }>(
      result as Parameters<typeof parseJsonContent>[0]
    );
    expect(["db", "file"]).toContain(payload.backend);
    expect(payload.stats).toBeDefined();
  }, 90_000);
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
      const result = await cl.readResource({ uri: "minder://usage/7d" });
      const payload = parseJsonContent<{ backend: string; report: { period: string } }>(
        result as Parameters<typeof parseJsonContent>[0]
      );
      expect(["db", "file"]).toContain(payload.backend);
      expect(payload.report).toHaveProperty("period");
    },
    90_000
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
