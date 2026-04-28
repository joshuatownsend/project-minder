import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMcpServers, scanMcpServers } from "@/lib/scanner/mcpServers";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from "fs";
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => vi.clearAllMocks());

describe("parseMcpServers", () => {
  it("returns empty for non-objects", () => {
    expect(parseMcpServers(null,  "project", "/x")).toEqual([]);
    expect(parseMcpServers([],    "project", "/x")).toEqual([]);
    expect(parseMcpServers("str", "project", "/x")).toEqual([]);
  });

  it("infers stdio transport when command is present", () => {
    const result = parseMcpServers(
      { foo: { command: "node", args: ["server.js"] } },
      "project",
      "/proj/.mcp.json"
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "foo",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      source: "project",
      sourcePath: "/proj/.mcp.json",
    });
  });

  it("infers http transport when only url is present", () => {
    const result = parseMcpServers(
      { foo: { url: "https://example.com/mcp" } },
      "project",
      "/x"
    );
    expect(result[0].transport).toBe("http");
  });

  it("respects explicit `type` over inference", () => {
    const result = parseMcpServers(
      { foo: { url: "https://example.com", type: "sse" } },
      "project",
      "/x"
    );
    expect(result[0].transport).toBe("sse");
  });

  it("surfaces env KEY NAMES only — never values", () => {
    const result = parseMcpServers(
      { db: { command: "x", env: { POSTGRES_CONNECTION_STRING: "secret-value", DEBUG: "1" } } },
      "project",
      "/x"
    );
    expect(result[0].envKeys).toEqual(["POSTGRES_CONNECTION_STRING", "DEBUG"]);
    // The McpServer type does not include env values; check the serialized output:
    expect(JSON.stringify(result[0])).not.toContain("secret-value");
  });

  it("omits envKeys when env is empty or missing", () => {
    const result = parseMcpServers(
      { foo: { command: "x" }, bar: { command: "y", env: {} } },
      "project",
      "/x"
    );
    expect(result[0].envKeys).toBeUndefined();
    expect(result[1].envKeys).toBeUndefined();
  });

  it("uses 'unknown' transport when neither command, url, nor type indicate one", () => {
    const result = parseMcpServers({ foo: {} }, "project", "/x");
    expect(result[0].transport).toBe("unknown");
  });
});

describe("scanMcpServers", () => {
  it("returns undefined when .mcp.json is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await scanMcpServers("C:\\dev\\fake")).toBeUndefined();
  });

  it("parses a valid project-level .mcp.json", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({
      mcpServers: {
        postgres: { command: "cmd", args: ["/c", "npx", "pg-server"], env: { CONN: "x" } },
      },
    }));
    const result = await scanMcpServers("C:\\dev\\proj");
    expect(result?.servers).toHaveLength(1);
    expect(result!.servers[0].name).toBe("postgres");
    expect(result!.servers[0].source).toBe("project");
    expect(result!.servers[0].envKeys).toEqual(["CONN"]);
  });

  it("tolerates `//` comments in .mcp.json", async () => {
    mockReadFile.mockResolvedValue(`{
      // comment
      "mcpServers": { "x": { "command": "node" } }
    }`);
    const result = await scanMcpServers("C:\\dev\\proj");
    expect(result?.servers).toHaveLength(1);
  });

  it("returns undefined when mcpServers is empty or absent", async () => {
    mockReadFile.mockResolvedValue("{}");
    expect(await scanMcpServers("C:\\dev\\proj")).toBeUndefined();
  });
});
