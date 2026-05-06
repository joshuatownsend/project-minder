import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/userConfigCache", () => ({ getUserConfig: vi.fn() }));
vi.mock("@/lib/indexer/catalog", () => ({ loadCatalog: vi.fn() }));
vi.mock("@/lib/data/index", () => ({ getAgentUsage: vi.fn(), getSkillUsage: vi.fn() }));
vi.mock("@/lib/scanner/pluginMcp", () => ({ readPluginScopeMcp: vi.fn() }));

import { getUserConfig } from "@/lib/userConfigCache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getAgentUsage, getSkillUsage } from "@/lib/data/index";
import { readPluginScopeMcp } from "@/lib/scanner/pluginMcp";

const mockGetUserConfig = vi.mocked(getUserConfig);
const mockLoadCatalog = vi.mocked(loadCatalog);
const mockGetAgentUsage = vi.mocked(getAgentUsage);
const mockGetSkillUsage = vi.mocked(getSkillUsage);
const mockReadPluginScopeMcp = vi.mocked(readPluginScopeMcp);

function makePlugin(name: string, installPath?: string) {
  return {
    name,
    marketplace: "anthropics/plugins",
    enabled: true,
    blocked: false,
    installPath,
  };
}

function makeAgent(name: string, pluginName?: string) {
  return { name, pluginName, kind: "agent" as const, source: "plugin" as const };
}

function makeSkill(name: string, pluginName?: string) {
  return { name, pluginName, kind: "skill" as const, source: "plugin" as const };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear cache between tests
  const g = globalThis as unknown as { __pluginRollupCache?: unknown };
  g.__pluginRollupCache = null;
});

describe("loadPluginRollup", () => {
  async function freshRollup() {
    vi.resetModules();
    return import("@/lib/data/pluginRollup");
  }

  function setupMocks(opts: {
    plugins?: ReturnType<typeof makePlugin>[];
    agents?: ReturnType<typeof makeAgent>[];
    skills?: ReturnType<typeof makeSkill>[];
    agentStats?: { name: string; invocations: number }[];
    skillStats?: { name: string; invocations: number }[];
    mcpServers?: { name: string; sourcePath: string }[];
  } = {}) {
    mockGetUserConfig.mockResolvedValue({
      plugins: { plugins: opts.plugins ?? [] },
    } as unknown as Awaited<ReturnType<typeof getUserConfig>>);

    mockLoadCatalog.mockResolvedValue({
      agents: opts.agents ?? [],
      skills: opts.skills ?? [],
    } as unknown as Awaited<ReturnType<typeof loadCatalog>>);

    mockGetAgentUsage.mockResolvedValue({
      stats: (opts.agentStats ?? []).map((s) => ({ ...s, projects: {}, sessions: [] })),
      meta: { backend: "db" as const },
    });

    mockGetSkillUsage.mockResolvedValue({
      stats: (opts.skillStats ?? []).map((s) => ({ ...s, projects: {}, sessions: [] })),
      meta: { backend: "db" as const },
    });

    mockReadPluginScopeMcp.mockResolvedValue(
      (opts.mcpServers ?? []).map((m) => ({
        ...m,
        transport: "stdio" as const,
        source: "plugin" as const,
      }))
    );
  }

  it("returns empty array when no plugins are installed", async () => {
    setupMocks({ plugins: [] });
    const { loadPluginRollup } = await freshRollup();
    expect(await loadPluginRollup()).toEqual([]);
  });

  it("counts agents and skills per plugin by pluginName", async () => {
    setupMocks({
      plugins: [makePlugin("context7", "/home/.claude/plugins/context7")],
      agents: [
        makeAgent("context7-search", "context7"),
        makeAgent("context7-index", "context7"),
        makeAgent("other-agent", "other-plugin"),
      ],
      skills: [makeSkill("context7-skill", "context7")],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows).toHaveLength(1);
    expect(rows[0].agentCount).toBe(2);
    expect(rows[0].skillCount).toBe(1);
  });

  it("sums invocations for agents and skills belonging to the plugin", async () => {
    setupMocks({
      plugins: [makePlugin("clerk", "/home/.claude/plugins/clerk")],
      agents: [makeAgent("clerk-verify", "clerk"), makeAgent("clerk-sync", "clerk")],
      skills: [makeSkill("clerk-auth", "clerk")],
      agentStats: [
        { name: "clerk-verify", invocations: 10 },
        { name: "clerk-sync", invocations: 5 },
        { name: "other-agent", invocations: 99 },
      ],
      skillStats: [{ name: "clerk-auth", invocations: 3 }],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows[0].totalInvocations).toBe(18); // 10 + 5 + 3
  });

  it("counts MCP servers by installPath prefix match", async () => {
    const installPath = "/home/.claude/plugins/context7";
    setupMocks({
      plugins: [makePlugin("context7", installPath)],
      mcpServers: [
        { name: "ctx-mcp", sourcePath: `${installPath}/.mcp.json` },
        { name: "other-mcp", sourcePath: "/home/.claude/plugins/other/.mcp.json" },
      ],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows[0].mcpServerCount).toBe(1);
  });

  it("sets mcpServerCount to 0 when plugin has no installPath", async () => {
    setupMocks({
      plugins: [makePlugin("ghost-plugin")], // no installPath
      mcpServers: [{ name: "mcp", sourcePath: "/somewhere/.mcp.json" }],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows[0].mcpServerCount).toBe(0);
  });

  it("sets all counts to 0 when plugin has no catalog entries", async () => {
    setupMocks({
      plugins: [makePlugin("empty-plugin", "/plugins/empty")],
      agents: [],
      skills: [],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows[0]).toMatchObject({
      agentCount: 0,
      skillCount: 0,
      mcpServerCount: 0,
      totalInvocations: 0,
    });
  });

  it("returns one row per installed plugin", async () => {
    setupMocks({
      plugins: [
        makePlugin("plugin-a", "/plugins/a"),
        makePlugin("plugin-b", "/plugins/b"),
      ],
    });
    const { loadPluginRollup } = await freshRollup();
    const rows = await loadPluginRollup();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.plugin.name)).toEqual(["plugin-a", "plugin-b"]);
  });
});
