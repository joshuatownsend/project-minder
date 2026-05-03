import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { extractHookEntries } from "./scanner/claudeHooks";
import { parseMcpServers } from "./scanner/mcpServers";
import { readClaudeJsonMcp } from "./scanner/claudeJsonMcp";
import { readPluginScopeMcp } from "./scanner/pluginMcp";
import { readDesktopScopeMcp } from "./scanner/desktopMcp";
import { readManagedScopeMcp } from "./scanner/managedMcp";
import { tryParseJsonc } from "./scanner/util/jsonc";
import { loadInstalledPlugins } from "./indexer/walkPlugins";
import { RESERVED_SETTINGS_KEYS } from "./template/jsonPath";
import {
  HookEntry,
  McpServer,
  PluginEntry,
  PluginsInfo,
  SettingsKeyEntry,
  UserConfig,
} from "./types";

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

interface CacheSlot {
  data: UserConfig;
  cachedAt: number;
}

const globalForUC = globalThis as unknown as {
  __userConfigCache?: CacheSlot;
};

export function invalidateUserConfigCache(): void {
  globalForUC.__userConfigCache = undefined;
}

export async function getUserConfig(): Promise<UserConfig> {
  const slot = globalForUC.__userConfigCache;
  if (slot && Date.now() - slot.cachedAt < CACHE_TTL_MS) {
    return slot.data;
  }
  const data = await readUserConfig();
  globalForUC.__userConfigCache = { data, cachedAt: Date.now() };
  return data;
}

async function readUserConfig(): Promise<UserConfig> {
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  // Read all sources in parallel — they touch disjoint files and the
  // slowest source (plugin scan, ~N file reads) shouldn't be serialized
  // behind the others.
  const [settings, claudeJsonMcp, pluginMcp, desktopMcp, managedMcp] =
    await Promise.all([
      readSettings(settingsPath),
      readClaudeJsonMcp(),
      readPluginScopeMcp(),
      readDesktopScopeMcp(),
      readManagedScopeMcp(),
    ]);

  const plugins = await readPluginsInfo(claudeDir, settings);

  const hookEntries: HookEntry[] = settings
    ? extractHookEntries(settings.hooks, "user", settingsPath)
    : [];

  // Merge MCP servers from every known source. No dedup on name
  // collisions across sources — both entries surface, and downstream
  // (apply policy, UI grouping) decides what to do.
  // Order = source-precedence story shown to the user:
  // managed (admin policy) → user-from-settings.json → user-from-claude.json
  // → desktop → plugin. Local-scope per-project servers are surfaced
  // separately on the project detail page (see readLocalScopeMcpFromClaudeJson)
  // so they don't leak into the global "user" list.
  const mcpServers: McpServer[] = [
    ...managedMcp,
    ...(settings
      ? parseMcpServers(settings.mcpServers, "user", settingsPath)
      : []),
    ...claudeJsonMcp.user,
    ...desktopMcp,
    ...pluginMcp,
  ];

  return {
    plugins,
    hooks: { entries: hookEntries },
    mcpServers: { servers: mcpServers },
    settingsKeys: settings ? extractSettingsKeys(settings) : [],
  };
}

/** @internal Exported for vitest. */
export function extractSettingsKeys(doc: Record<string, unknown>): SettingsKeyEntry[] {
  return Object.entries(doc)
    .filter(([k]) => !RESERVED_SETTINGS_KEYS.has(k))
    .map(([keyPath, value]) => ({ keyPath, value }));
}

async function readSettings(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return tryParseJsonc<Record<string, unknown>>(raw);
  } catch {
    return null;
  }
}

async function readPluginsInfo(
  claudeDir: string,
  settings: Record<string, unknown> | null
): Promise<PluginsInfo> {
  const [installed, blocklist] = await Promise.all([
    loadInstalledPlugins(),
    readBlocklist(path.join(claudeDir, "plugins", "blocklist.json")),
  ]);

  const enabledMap = (settings?.enabledPlugins as Record<string, unknown> | undefined) ?? {};
  const blockedSet = new Set(blocklist);

  const installedKeys = new Set<string>();
  const plugins: PluginEntry[] = [];

  for (const ip of installed) {
    const key = ip.marketplace ? `${ip.pluginName}@${ip.marketplace}` : ip.pluginName;
    installedKeys.add(key);
    plugins.push({
      name: ip.pluginName,
      marketplace: ip.marketplace,
      enabled: enabledMap[key] === true,
      blocked: blockedSet.has(key),
      version: ip.version,
      installedAt: ip.installedAt,
      lastUpdated: ip.lastUpdated,
      installPath: ip.installPath,
      gitCommitSha: ip.gitCommitSha,
      pluginRepoUrl: ip.pluginRepoUrl,
    });
  }

  // Surface plugins that appear in `enabledPlugins` but not in installed_plugins.json
  // (e.g. from another scope) so the user still sees them.
  for (const [key, value] of Object.entries(enabledMap)) {
    if (installedKeys.has(key)) continue;
    const lastAt = key.lastIndexOf("@");
    const name = lastAt > 0 ? key.slice(0, lastAt) : key;
    const marketplace = lastAt > 0 ? key.slice(lastAt + 1) : "";
    plugins.push({
      name,
      marketplace,
      enabled: value === true,
      blocked: blockedSet.has(key),
    });
  }

  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins };
}

async function readBlocklist(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const doc = tryParseJsonc<{ plugins?: Array<{ plugin?: unknown }> }>(raw);
    if (!doc?.plugins) return [];
    return doc.plugins
      .map((p) => p.plugin)
      .filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

