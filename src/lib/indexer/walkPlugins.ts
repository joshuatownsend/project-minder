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
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
}

interface PluginManifest {
  repository?: string;
}

async function readPluginRepoUrl(installPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      "utf-8"
    );
    const manifest = JSON.parse(raw) as PluginManifest;
    return typeof manifest.repository === "string" ? manifest.repository : undefined;
  } catch {
    return undefined;
  }
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

    await Promise.all(
      Object.entries(pluginMap).map(async ([key, installs]) => {
        if (!Array.isArray(installs) || installs.length === 0) return;

        // key format: "pluginname@marketplace" — split on last @ to preserve scoped names
        const lastAt = key.lastIndexOf("@");
        const pluginName = lastAt > 0 ? key.slice(0, lastAt) : key;
        const marketplace = lastAt > 0 ? key.slice(lastAt + 1) : "";

        const install = installs[0];
        if (!install.installPath) return;

        const installPath = path.normalize(install.installPath);
        if (seen.has(installPath)) return;
        seen.add(installPath);

        const pluginRepoUrl = await readPluginRepoUrl(installPath);

        results.push({
          pluginName,
          installPath,
          marketplace,
          scope: install.scope,
          version: install.version,
          installedAt: install.installedAt,
          lastUpdated: install.lastUpdated,
          gitCommitSha: install.gitCommitSha,
          pluginRepoUrl,
        });
      })
    );

    return results;
  } catch {
    return [];
  }
}
