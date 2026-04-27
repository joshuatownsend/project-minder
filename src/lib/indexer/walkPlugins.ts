import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { InstalledPlugin } from "./types";

interface PluginsFile {
  version?: number;
  plugins?: Record<string, PluginInstall[]>;
}

interface PluginInstall {
  scope?: string;
  installPath?: string;
  version?: string;
}

export async function loadInstalledPlugins(): Promise<InstalledPlugin[]> {
  const registryPath = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "installed_plugins.json"
  );

  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const data = JSON.parse(raw) as PluginsFile;

    const pluginMap = data.plugins ?? {};
    const results: InstalledPlugin[] = [];
    const seen = new Set<string>();

    for (const [key, installs] of Object.entries(pluginMap)) {
      if (!Array.isArray(installs) || installs.length === 0) continue;

      // key format: "pluginname@marketplace" — take the part before @
      const pluginName = key.includes("@") ? key.split("@")[0] : key;

      // Use first install entry
      const install = installs[0];
      if (!install.installPath) continue;

      const installPath = path.normalize(install.installPath);

      // Deduplicate by installPath
      if (seen.has(installPath)) continue;
      seen.add(installPath);

      results.push({ pluginName, installPath });
    }

    return results;
  } catch {
    return [];
  }
}
