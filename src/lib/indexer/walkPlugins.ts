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
  /** Where the plugin keeps its skills. String or array; `"."` means the plugin root (2.1.218). */
  skills?: unknown;
}

function parseSemverParts(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [-1, -1, -1];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareSemver(a: string, b: string): number {
  const [amaj, amin, apatch] = parseSemverParts(a);
  const [bmaj, bmin, bpatch] = parseSemverParts(b);
  if (amaj !== bmaj) return amaj - bmaj;
  if (amin !== bmin) return amin - bmin;
  if (apatch !== bpatch) return apatch - bpatch;
  // Stable beats pre-release: "1.2.3" > "1.2.3-beta"
  const aPrerelease = /^\d+\.\d+\.\d+-./.test(a);
  const bPrerelease = /^\d+\.\d+\.\d+-./.test(b);
  if (aPrerelease !== bPrerelease) return aPrerelease ? -1 : 1;
  return a.localeCompare(b);
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

/**
 * Directories a plugin keeps its skills in, resolved absolute.
 *
 * Defaults to `<installPath>/skills`, which is all Minder used to look at. Since
 * 2.1.218 a manifest may point elsewhere, and `"."` — the plugin root, for a
 * repo that *is* one skill — is explicitly allowed. A plugin using either was
 * invisible to the catalog: not mis-parsed, just never opened.
 *
 * Paths are resolved and then checked to be inside `installPath`, so a manifest
 * saying `"../../.."` can't walk the reader out of the plugin directory.
 */
export async function resolvePluginSkillsRoots(installPath: string): Promise<string[]> {
  let declared: unknown;
  try {
    const raw = await fs.readFile(
      path.join(installPath, ".claude-plugin", "plugin.json"),
      "utf-8"
    );
    declared = (JSON.parse(raw) as PluginManifest).skills;
  } catch {
    // No manifest, or unreadable — fall through to the default.
  }

  const candidates =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((p): p is string => typeof p === "string")
        : [];
  if (candidates.length === 0) candidates.push("skills");

  const base = path.resolve(installPath);
  const roots: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(base, candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) continue;
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
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

        // Pick the highest semver when multiple installs exist for the same key.
        const sorted = [...installs].sort((a, b) =>
          compareSemver(b.version ?? "", a.version ?? "")
        );
        const install = sorted[0];
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
