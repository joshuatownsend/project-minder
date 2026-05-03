import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// readClaudeJsonMcp extracts ONLY the mcpServers blocks from ~/.claude.json
// and never lets the parsed root (which contains OAuth tokens, telemetry IDs,
// and other Claude Code runtime state) leak through. These tests pin both
// the parse correctness AND the "no leak past the boundary" invariant.

let tmpHome: string;

async function reloadModule() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return await import("@/lib/scanner/claudeJsonMcp");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-claude-json-mcp-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("readClaudeJsonMcp", () => {
  it("returns empty extracts when ~/.claude.json does not exist", async () => {
    const mod = await reloadModule();
    const out = await mod.readClaudeJsonMcp();
    expect(out.user).toEqual([]);
    expect(out.byProject.size).toBe(0);
  });

  it("returns empty extracts when ~/.claude.json is malformed JSON", async () => {
    const mod = await reloadModule();
    await fs.writeFile(path.join(tmpHome, ".claude.json"), "{ this is not json", "utf-8");
    const out = await mod.readClaudeJsonMcp();
    expect(out.user).toEqual([]);
    expect(out.byProject.size).toBe(0);
  });

  it("extracts user-scope mcpServers and tags source='user'", async () => {
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
        },
      }),
      "utf-8",
    );
    const out = await mod.readClaudeJsonMcp();
    expect(out.user).toHaveLength(1);
    expect(out.user[0]).toMatchObject({
      name: "memory",
      command: "npx",
      transport: "stdio",
      source: "user",
    });
  });

  it("extracts per-project local-scope mcpServers keyed on project path", async () => {
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: {
          "C:\\dev\\proj-a": {
            mcpServers: { foo: { command: "node", args: ["a.js"] } },
          },
          "C:\\dev\\proj-b": {
            // Empty mcpServers should not produce a map entry.
            mcpServers: {},
          },
          "C:\\dev\\proj-c": {
            // No mcpServers at all should not produce a map entry.
            other: "ignored",
          },
        },
      }),
      "utf-8",
    );
    const out = await mod.readClaudeJsonMcp();
    expect(out.byProject.size).toBe(1);
    const fooList = out.byProject.get("C:\\dev\\proj-a");
    expect(fooList).toHaveLength(1);
    expect(fooList?.[0]).toMatchObject({
      name: "foo",
      command: "node",
      source: "local",
    });
  });

  it("never returns OAuth tokens, telemetry IDs, or other root-level fields", async () => {
    // Pin the security boundary: the function MUST extract only mcpServers
    // and projects[*].mcpServers. If any future refactor accidentally keeps
    // a reference to the parsed root, this test fails when the OAuth-shaped
    // string surfaces in JSON.stringify(out).
    const mod = await reloadModule();
    const sensitive = "sk-ant-oauth-FAKE-TOKEN-FOR-TEST-ONLY-deadbeef";
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accessToken: sensitive, email: "leak@example.com" },
        telemetryUserId: "telemetry-uuid-leak",
        firstStartTime: "2026-01-01T00:00:00Z",
        userID: "user-id-leak",
        primaryApiKey: "sk-ant-api-FAKE-key-leak",
        mcpServers: {
          ok: { command: "node", args: ["server.js"] },
        },
        projects: {
          "C:\\dev\\proj-a": {
            history: [{ display: "secret-prompt-text" }],
            mcpServers: { okProj: { command: "node", args: ["a.js"] } },
          },
        },
      }),
      "utf-8",
    );

    const out = await mod.readClaudeJsonMcp();
    const serialized = JSON.stringify({
      user: out.user,
      byProject: Array.from(out.byProject.entries()),
    });

    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain("oauthAccount");
    expect(serialized).not.toContain("telemetryUserId");
    expect(serialized).not.toContain("firstStartTime");
    expect(serialized).not.toContain("primaryApiKey");
    expect(serialized).not.toContain("user-id-leak");
    expect(serialized).not.toContain("secret-prompt-text");

    // Sanity: the legitimate data IS present.
    expect(out.user.map((s) => s.name)).toEqual(["ok"]);
    expect(out.byProject.get("C:\\dev\\proj-a")?.map((s) => s.name)).toEqual(["okProj"]);
  });

  it("strips env values, keeping only env key names", async () => {
    // The shared parseMcpServers already does this — pin it for this
    // reader specifically so a future bypass of the shared parser
    // (e.g. inlined parsing) would fail loudly.
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          secrets: {
            command: "node",
            env: {
              SECRET_KEY: "should-not-appear-in-output",
              ANOTHER_TOKEN: "also-should-not-appear",
            },
          },
        },
      }),
      "utf-8",
    );
    const out = await mod.readClaudeJsonMcp();
    expect(out.user[0].envKeys).toEqual(["SECRET_KEY", "ANOTHER_TOKEN"]);
    expect(JSON.stringify(out)).not.toContain("should-not-appear-in-output");
    expect(JSON.stringify(out)).not.toContain("also-should-not-appear");
  });
});

describe("readUserScopeMcpFromClaudeJson convenience wrapper", () => {
  it("returns just the user-scope list", async () => {
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { a: { command: "x" } },
        projects: { "p": { mcpServers: { b: { command: "y" } } } },
      }),
      "utf-8",
    );
    const list = await mod.readUserScopeMcpFromClaudeJson();
    expect(list.map((s) => s.name)).toEqual(["a"]);
  });
});

describe("readLocalScopeMcpFromClaudeJson convenience wrapper", () => {
  it("returns local-scope list for a known project path", async () => {
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: {
          "C:\\dev\\target": { mcpServers: { hit: { command: "ok" } } },
          "C:\\dev\\other": { mcpServers: { miss: { command: "no" } } },
        },
      }),
      "utf-8",
    );
    const list = await mod.readLocalScopeMcpFromClaudeJson("C:\\dev\\target");
    expect(list.map((s) => s.name)).toEqual(["hit"]);
  });

  it("returns [] for an unknown project path", async () => {
    const mod = await reloadModule();
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: { "C:\\dev\\target": { mcpServers: { hit: { command: "ok" } } } },
      }),
      "utf-8",
    );
    const list = await mod.readLocalScopeMcpFromClaudeJson("C:\\dev\\nope");
    expect(list).toEqual([]);
  });

  it("normalizes trailing-slash and separator differences when matching", async () => {
    // Pin the normalization promise from the docstring: callers should
    // not have to bit-exact-match Claude Code's stored key. Whatever
    // path.normalize considers equivalent must match. The exact
    // canonicalization rules are platform-specific (separator on win32
    // vs posix), so test using path.join itself to produce the variants.
    const mod = await reloadModule();
    const stored = path.join("dir", "subdir", "project");
    const queryWithTrailing = stored + path.sep;
    await fs.writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: { [stored]: { mcpServers: { hit: { command: "ok" } } } },
      }),
      "utf-8",
    );
    const list = await mod.readLocalScopeMcpFromClaudeJson(queryWithTrailing);
    expect(list.map((s) => s.name)).toEqual(["hit"]);
  });
});
