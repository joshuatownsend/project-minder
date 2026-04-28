import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { applyMcp } from "@/lib/template/applyMcp";
import type { McpServer } from "@/lib/types";

let tmp: string;
let target: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyMcp-test-"));
  target = path.join(tmp, "target");
  await fs.mkdir(target, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function srv(overrides: Partial<McpServer> = {}): McpServer {
  return {
    name: "ctx",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    source: "project",
    sourcePath: path.join(tmp, "src", ".mcp.json"),
    ...overrides,
  };
}

async function readMcp(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

describe("applyMcp — happy path", () => {
  it("creates .mcp.json when missing and writes the server entry", async () => {
    const result = await applyMcp({
      server: srv(),
      targetProjectPath: target,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>;
    };
    expect(doc.mcpServers.ctx).toEqual({ type: "stdio", command: "node", args: ["server.mjs"] });
  });

  it("preserves existing keys in .mcp.json", async () => {
    await fs.writeFile(
      path.join(target, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "http", url: "https://x" } }, otherKey: 1 }),
      "utf-8"
    );

    await applyMcp({ server: srv(), targetProjectPath: target, conflict: "skip" });

    const doc = (await readMcp(path.join(target, ".mcp.json"))) as Record<string, unknown>;
    const servers = doc.mcpServers as Record<string, unknown>;
    expect(servers.other).toBeDefined();
    expect(servers.ctx).toBeDefined();
    expect(doc.otherKey).toBe(1);
  });
});

describe("applyMcp — env-key-only invariant", () => {
  it("writes empty-string placeholders for env keys, never values", async () => {
    const result = await applyMcp({
      server: srv({ envKeys: ["API_KEY", "SECRET"] }),
      targetProjectPath: target,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toMatch(/env values to fill in/);

    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: { ctx: { env: Record<string, string> } };
    };
    expect(doc.mcpServers.ctx.env).toEqual({ API_KEY: "", SECRET: "" });
  });

  it("omits env entirely when source has no env keys", async () => {
    await applyMcp({
      server: srv({ envKeys: undefined }),
      targetProjectPath: target,
      conflict: "skip",
    });
    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: { ctx: Record<string, unknown> };
    };
    expect(doc.mcpServers.ctx).not.toHaveProperty("env");
  });
});

describe("applyMcp — conflicts", () => {
  it("skips when name exists and conflict=skip", async () => {
    await fs.writeFile(
      path.join(target, ".mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { type: "http", url: "https://existing" } } }),
      "utf-8"
    );

    const result = await applyMcp({
      server: srv(),
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.status).toBe("skipped");

    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: { ctx: { url: string } };
    };
    expect(doc.mcpServers.ctx.url).toBe("https://existing");
  });

  it("renames with `-from-<sourceSlug>` when conflict=rename", async () => {
    await fs.writeFile(
      path.join(target, ".mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { type: "stdio", command: "old" } } }),
      "utf-8"
    );

    const result = await applyMcp({
      server: srv(),
      targetProjectPath: target,
      conflict: "rename",
      sourceSlug: "myproj",
    });
    expect(result.status).toBe("applied");

    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers).toHaveProperty("ctx");
    expect(doc.mcpServers).toHaveProperty("ctx-from-myproj");
  });

  it("overwrites at the same key when conflict=overwrite", async () => {
    await fs.writeFile(
      path.join(target, ".mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { type: "http", url: "https://old" } } }),
      "utf-8"
    );

    await applyMcp({
      server: srv({ command: "new-binary" }),
      targetProjectPath: target,
      conflict: "overwrite",
    });

    const doc = (await readMcp(path.join(target, ".mcp.json"))) as {
      mcpServers: { ctx: { command?: string; url?: string } };
    };
    expect(doc.mcpServers.ctx.command).toBe("new-binary");
    expect(doc.mcpServers.ctx.url).toBeUndefined();
  });
});

describe("applyMcp — malformed target", () => {
  it("refuses to overwrite a malformed .mcp.json", async () => {
    await fs.writeFile(path.join(target, ".mcp.json"), "{ not valid", "utf-8");

    const result = await applyMcp({
      server: srv(),
      targetProjectPath: target,
      conflict: "skip",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MALFORMED_TARGET");
    expect(await fs.readFile(path.join(target, ".mcp.json"), "utf-8")).toBe("{ not valid");
  });
});

describe("applyMcp — dryRun", () => {
  it("dryRun returns would-apply with preview, no write", async () => {
    const result = await applyMcp({
      server: srv(),
      targetProjectPath: target,
      conflict: "skip",
      dryRun: true,
    });

    expect(result.status).toBe("would-apply");
    expect(result.diffPreview).toContain("[add] mcpServers.ctx");
    await expect(fs.access(path.join(target, ".mcp.json"))).rejects.toThrow();
  });
});
