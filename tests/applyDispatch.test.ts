/**
 * Integration tests for applyUnit's user-scope routing.
 *
 * Each test verifies that source: { kind: "user" } is served from
 * getUserConfig() — not from project scanners — and that the promotion
 * warning surfaces in the result.
 *
 * One test per dispatcher: hook, mcp, plugin, settingsKey.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { makeHookKey } from "@/lib/template/unitKey";
import type { HookEntry, McpServer, UserConfig } from "@/lib/types";

// ── Hoisted mutable state (safe to reference inside vi.mock factories) ───────
const state = vi.hoisted(() => ({
  tmp: "",
  targetPath: "",
  fakeHome: "",
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/config", () => ({
  readConfig: async () => ({
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: state.tmp,
    pinnedSlugs: [],
  }),
  getDevRoots: (cfg: { devRoot: string; devRoots?: string[] }) =>
    cfg.devRoots?.length ? cfg.devRoots : [cfg.devRoot],
}));

vi.mock("@/lib/cache", () => ({
  getCachedScan: vi.fn(() => ({
    projects: [],
    portConflicts: [],
    hiddenCount: 0,
    scannedAt: new Date().toISOString(),
  })),
  setCachedScan: vi.fn(() => {}),
  invalidateCache: vi.fn(() => {}),
}));

vi.mock("@/lib/userConfigCache", () => ({
  getUserConfig: vi.fn(),
  invalidateUserConfigCache: () => {},
}));

// Scanners should NOT be called for user-scope dispatch.
vi.mock("@/lib/scanner/claudeHooks", () => ({
  scanClaudeHooks: vi.fn(async () => {
    throw new Error("scanClaudeHooks should not be called for user-scope");
  }),
}));
vi.mock("@/lib/scanner/mcpServers", () => ({
  scanMcpServers: vi.fn(async () => {
    throw new Error("scanMcpServers should not be called for user-scope");
  }),
}));
vi.mock("@/lib/scanner/projectPlugins", () => ({
  scanProjectPluginEnables: vi.fn(async () => {
    throw new Error("scanProjectPluginEnables should not be called for user-scope");
  }),
}));

// applyPlugin internally checks loadInstalledPlugins for the "requires install" warning.
vi.mock("@/lib/indexer/walkPlugins", () => ({
  loadInstalledPlugins: async () => [
    { pluginName: "review", marketplace: "official", installPath: "/fake" },
  ],
}));

// Cache invalidation — noop in tests.
vi.mock("@/lib/indexer/catalog", () => ({ invalidateCatalogCache: () => {} }));
vi.mock("@/app/api/claude-config/route", () => ({
  invalidateClaudeConfigRouteCache: () => {},
}));
vi.mock("@/app/api/commands/route", () => ({
  invalidateCommandsRouteCache: () => {},
}));

// Scan should never be triggered — getCachedScan always returns a result above.
// toSlug is the canonical slug derivation used by snapshotBeforeApply's
// path-target fallback; preserve it from the real module so apply layer
// snapshots get a consistent slug even when the path isn't in the scan.
vi.mock("@/lib/scanner", () => ({
  scanAllProjects: async () => {
    throw new Error("scanAllProjects should not be called in dispatch tests");
  },
  toSlug: (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
}));

// ── Imports (resolved after mocks are installed) ──────────────────────────────
import { applyUnit } from "@/lib/template/apply";
import { getUserConfig } from "@/lib/userConfigCache";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeUserConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    hooks: { entries: [] },
    mcpServers: { servers: [] },
    plugins: { plugins: [] },
    settingsKeys: [],
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  state.tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyDispatch-test-"));
  state.targetPath = path.join(state.tmp, "tgt");
  state.fakeHome = path.join(state.tmp, "home");
  await Promise.all([
    fs.mkdir(path.join(state.targetPath, ".claude"), { recursive: true }),
    fs.mkdir(path.join(state.fakeHome, ".claude"), { recursive: true }),
  ]);
  vi.spyOn(os, "homedir").mockReturnValue(state.fakeHome);
  vi.mocked(getUserConfig).mockResolvedValue(makeUserConfig());
});

afterEach(async () => {
  await fs.rm(state.tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("applyDispatch — user-scope hook", () => {
  it("reads from getUserConfig().hooks and writes hook + promotion warning to target", async () => {
    const command = "echo hello";
    const key = makeHookKey("PostToolUse", "Edit", command);
    const hookEntry: HookEntry = {
      event: "PostToolUse",
      matcher: "Edit",
      commands: [{ type: "command", command }],
      source: "user",
      sourcePath: path.join(state.fakeHome, ".claude", "settings.json"),
    };

    vi.mocked(getUserConfig).mockResolvedValue(
      makeUserConfig({ hooks: { entries: [hookEntry] } })
    );

    const result = await applyUnit({
      unit: { kind: "hook", key },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    // Promotion warning surfaced.
    expect(result.warnings?.some((w) => /user-scope/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /anyone using this repo/.test(w))).toBe(true);
    // getUserConfig was used (not the project scanner).
    expect(vi.mocked(getUserConfig)).toHaveBeenCalled();
    // Hook was actually written.
    const settings = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".claude", "settings.json"), "utf-8")
    ) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });
});

describe("applyDispatch — user-scope MCP", () => {
  it("reads from getUserConfig().mcpServers and writes server + promotion warning to target", async () => {
    const server: McpServer = {
      name: "my-server",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      source: "user",
      sourcePath: path.join(state.fakeHome, ".claude", "settings.json"),
    };

    vi.mocked(getUserConfig).mockResolvedValue(
      makeUserConfig({ mcpServers: { servers: [server] } })
    );

    const result = await applyUnit({
      unit: { kind: "mcp", key: "my-server" },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /user-scope/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /anyone using this repo/.test(w))).toBe(true);
    expect(vi.mocked(getUserConfig)).toHaveBeenCalled();
    const mcp = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".mcp.json"), "utf-8")
    ) as { mcpServers: Record<string, unknown> };
    expect(mcp.mcpServers["my-server"]).toBeDefined();
  });

  it("filters local-scope shadow out of project-source apply lookup", async () => {
    // Wave 1.2 follow-up #3 (Codex P2): scanMcpServers now merges
    // project-scope (.mcp.json) with local-scope (~/.claude.json
    // projects[<path>].mcpServers). Both arrive in the project-source
    // dispatch branch. Without a writable-source filter, applyMcp
    // would resolve to the local-scope entry and reject with
    // UNSUPPORTED_MCP_SOURCE_FOR_APPLY (or pick the wrong duplicate).
    // Pin the filter so the project-scope entry wins.
    const { scanMcpServers } = await import("@/lib/scanner/mcpServers");
    vi.mocked(scanMcpServers).mockResolvedValueOnce({
      servers: [
        // Local-scope shadow first to mimic the merge order.
        {
          name: "memory",
          transport: "stdio",
          command: "this-should-not-be-applied",
          source: "local",
          sourcePath: path.join(state.fakeHome, ".claude.json"),
        },
        {
          name: "memory",
          transport: "stdio",
          command: "this-IS-the-writable-one",
          source: "project",
          sourcePath: path.join(state.tmp, "src", ".mcp.json"),
        },
      ],
    });

    // Need a project in scan to resolve the source-project lookup.
    // Cast through unknown — ProjectData has many required fields that
    // the dispatch layer doesn't read, so a minimal stub suffices for
    // this test's purposes.
    const { getCachedScan } = await import("@/lib/cache");
    vi.mocked(getCachedScan).mockReturnValueOnce({
      projects: [
        { slug: "src", name: "src", path: path.join(state.tmp, "src") },
      ],
      portConflicts: [],
      hiddenCount: 0,
      scannedAt: new Date().toISOString(),
    } as unknown as ReturnType<typeof getCachedScan>);

    const result = await applyUnit({
      unit: { kind: "mcp", key: "memory" },
      source: { kind: "project", slug: "src" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    const mcp = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".mcp.json"), "utf-8")
    ) as { mcpServers: Record<string, { command: string }> };
    expect(mcp.mcpServers["memory"].command).toBe("this-IS-the-writable-one");
  });

  it("returns AMBIGUOUS_MCP_SOURCE when two writable user-scope entries share a name", async () => {
    // Wave 1.2 follow-up #4 (Codex P1): the writable-source filter
    // (s.source === "user") still lets through entries from BOTH
    // ~/.claude/settings.json AND ~/.claude.json (both tagged source:
    // "user" by parseMcpServers). findMcpByKey by name only would
    // silently pick the first by merge order — applying the WRONG
    // entry's command/env. Refuse to apply when ambiguous so the user
    // is forced to deduplicate rather than getting silently-wrong
    // behavior.
    const fromSettings: McpServer = {
      name: "memory",
      transport: "stdio",
      command: "from-settings.json",
      source: "user",
      sourcePath: path.join(state.fakeHome, ".claude", "settings.json"),
    };
    const fromClaudeJson: McpServer = {
      name: "memory",
      transport: "stdio",
      command: "from-claude.json",
      source: "user",
      sourcePath: path.join(state.fakeHome, ".claude.json"),
    };
    vi.mocked(getUserConfig).mockResolvedValue(
      makeUserConfig({ mcpServers: { servers: [fromSettings, fromClaudeJson] } })
    );

    const result = await applyUnit({
      unit: { kind: "mcp", key: "memory" },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AMBIGUOUS_MCP_SOURCE");
    // Error message should name both source files so the user knows
    // exactly which to clean up.
    expect(result.error?.message).toContain("settings.json");
    expect(result.error?.message).toContain(".claude.json");
    // Target file must NOT have been written.
    await expect(
      fs.access(path.join(state.targetPath, ".mcp.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("filters merged user-scope list to writable sources before name lookup", async () => {
    // Wave 1.2 follow-up: getUserConfig().mcpServers.servers now merges
    // managed/user/desktop/plugin entries into one list. Two of those
    // sources can share a server name (e.g. "memory" both managed and
    // user). dispatchMcp's findMcpByKey matches by NAME ONLY — without
    // a source filter, the managed entry (first in merge order) would
    // win the lookup, then applyMcp would reject with
    // UNSUPPORTED_MCP_SOURCE_FOR_APPLY. Pin the filter so the apply
    // resolves to the writable user-scope entry instead.
    const desktopShadow: McpServer = {
      name: "memory",
      transport: "stdio",
      command: "this-should-not-be-applied",
      source: "desktop",
      sourcePath: "/fake/claude_desktop_config.json",
    };
    const writableUser: McpServer = {
      name: "memory",
      transport: "stdio",
      command: "this-IS-the-writable-one",
      source: "user",
      sourcePath: path.join(state.fakeHome, ".claude.json"),
    };
    vi.mocked(getUserConfig).mockResolvedValue(
      // desktopShadow listed first to match the managed-first merge
      // order in userConfigCache; the filter must skip past it.
      makeUserConfig({ mcpServers: { servers: [desktopShadow, writableUser] } })
    );

    const result = await applyUnit({
      unit: { kind: "mcp", key: "memory" },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    const mcp = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".mcp.json"), "utf-8")
    ) as { mcpServers: Record<string, { command: string }> };
    expect(mcp.mcpServers["memory"].command).toBe("this-IS-the-writable-one");
  });
});

describe("applyDispatch — user-scope plugin", () => {
  it("reads from getUserConfig().plugins.plugins and writes enable + promotion warning to target", async () => {
    vi.mocked(getUserConfig).mockResolvedValue(
      makeUserConfig({
        plugins: {
          plugins: [
            { name: "review", marketplace: "official", enabled: true, blocked: false },
          ],
        },
      })
    );

    const result = await applyUnit({
      unit: { kind: "plugin", key: "review@official" },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /user-scope plugin enable/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /anyone using this repo/.test(w))).toBe(true);
    expect(vi.mocked(getUserConfig)).toHaveBeenCalled();
    const settings = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".claude", "settings.json"), "utf-8")
    ) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins["review@official"]).toBe(true);
  });
});

describe("applyDispatch — user-scope settingsKey", () => {
  it("reads from os.homedir()/.claude/settings.json and writes key + promotion warning to target", async () => {
    // Write source at fakeHome — dispatched uses os.homedir() to find this.
    await fs.writeFile(
      path.join(state.fakeHome, ".claude", "settings.json"),
      JSON.stringify({ statusLine: "user-pref" }, null, 2),
      "utf-8"
    );

    const result = await applyUnit({
      unit: { kind: "settingsKey", key: "statusLine" },
      source: { kind: "user" },
      target: { kind: "path", path: state.targetPath },
      conflict: "merge",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /user-scope/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /anyone using this repo/.test(w))).toBe(true);
    const settings = JSON.parse(
      await fs.readFile(path.join(state.targetPath, ".claude", "settings.json"), "utf-8")
    ) as { statusLine: string };
    expect(settings.statusLine).toBe("user-pref");
  });
});
