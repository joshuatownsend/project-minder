import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { extractHookEntries } from "./scanner/claudeHooks";
import { parseMcpServers } from "./scanner/mcpServers";
import { tryParseJsonc } from "./scanner/util/jsonc";
import { loadInstalledPlugins } from "./indexer/walkPlugins";
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

  const settings = await readSettings(settingsPath);
  const plugins = await readPluginsInfo(claudeDir, settings);

  const hookEntries: HookEntry[] = settings
    ? extractHookEntries(settings.hooks, "user", settingsPath)
    : [];

  const mcpServers: McpServer[] = settings
    ? parseMcpServers(settings.mcpServers, "user", settingsPath)
    : [];

  return {
    plugins,
    hooks: { entries: hookEntries },
    mcpServers: { servers: mcpServers },
    settingsKeys: settings ? extractSettingsKeys(settings) : [],
  };
}

/** Top-level keys excluded from `settingsKeys` because they have dedicated catalog tabs. */
const SETTINGS_KEY_EXCLUSIONS = new Set(["hooks", "mcpServers", "enabledPlugins"]);

/** @internal Exported for vitest. */
export function extractSettingsKeys(doc: Record<string, unknown>): SettingsKeyEntry[] {
  return Object.entries(doc)
    .filter(([k]) => !SETTINGS_KEY_EXCLUSIONS.has(k))
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

