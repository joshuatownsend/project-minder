import "server-only";
import { getUserConfig } from "@/lib/userConfigCache";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getAgentUsage, getSkillUsage } from "@/lib/data/index";
import { readPluginScopeMcp } from "@/lib/scanner/pluginMcp";
import type { PluginEntry } from "@/lib/types";

export interface PluginRollupRow {
  plugin: PluginEntry;
  agentCount: number;
  skillCount: number;
  mcpServerCount: number;
  totalInvocations: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000;

const g = globalThis as unknown as {
  __pluginRollupCache?: { data: PluginRollupRow[]; cachedAt: number } | null;
};

function getCache(): PluginRollupRow[] | null {
  const slot = g.__pluginRollupCache;
  if (!slot) return null;
  if (Date.now() - slot.cachedAt < CACHE_TTL_MS) return slot.data;
  g.__pluginRollupCache = null;
  return null;
}

export function invalidatePluginRollupCache(): void {
  g.__pluginRollupCache = null;
}

export async function loadPluginRollup(): Promise<PluginRollupRow[]> {
  const cached = getCache();
  if (cached) return cached;

  const [userConfig, catalog, agentUsage, skillUsage, mcpServers] = await Promise.all([
    getUserConfig(),
    loadCatalog({ includeProjects: false }),
    getAgentUsage(),
    getSkillUsage(),
    readPluginScopeMcp(),
  ]);

  const plugins = userConfig.plugins.plugins;

  const agentInvocations = new Map<string, number>(
    agentUsage.stats.map((s) => [s.name, s.invocations])
  );
  const skillInvocations = new Map<string, number>(
    skillUsage.stats.map((s) => [s.name, s.invocations])
  );

  const rows: PluginRollupRow[] = [];

  for (const plugin of plugins) {
    const pluginAgents = catalog.agents.filter((a) => a.pluginName === plugin.name);
    const pluginSkills = catalog.skills.filter((s) => s.pluginName === plugin.name);

    const agentInvTotal = pluginAgents.reduce(
      (sum, a) => sum + (agentInvocations.get(a.name) ?? 0),
      0
    );
    const skillInvTotal = pluginSkills.reduce(
      (sum, s) => sum + (skillInvocations.get(s.name) ?? 0),
      0
    );

    // MCP servers: match by installPath prefix of sourcePath
    const mcpServerCount = plugin.installPath
      ? mcpServers.filter((m) =>
          m.sourcePath.startsWith(plugin.installPath! + "/") ||
          m.sourcePath.startsWith(plugin.installPath! + "\\")
        ).length
      : 0;

    rows.push({
      plugin,
      agentCount: pluginAgents.length,
      skillCount: pluginSkills.length,
      mcpServerCount,
      totalInvocations: agentInvTotal + skillInvTotal,
    });
  }

  g.__pluginRollupCache = { data: rows, cachedAt: Date.now() };
  return rows;
}
