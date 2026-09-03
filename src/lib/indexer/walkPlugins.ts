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

/** Dot-separated pre-release identifiers after the numeric core, or `null`
 *  for a stable version (or anything without a `-` suffix). */
function prereleaseIds(v: string): string[] | null {
  const m = v.match(/^\d+\.\d+\.\d+-([^+]+)/);
  return m ? m[1].split(".") : null;
}

/** Ascending semver order; stable beats pre-release at equal numbers. Shared
 *  with the environments inventory so "highest installed version" means the
 *  same thing on both surfaces. */
export function compareSemver(a: string, b: string): number {
  const [amaj, amin, apatch] = parseSemverParts(a);
  const [bmaj, bmin, bpatch] = parseSemverParts(b);
  if (amaj !== bmaj) return amaj - bmaj;
  if (amin !== bmin) return amin - bmin;
  if (apatch !== bpatch) return apatch - bpatch;
  // Stable beats pre-release: "1.2.3" > "1.2.3-beta"
  const aPre = prereleaseIds(a);
  const bPre = prereleaseIds(b);
  if ((aPre === null) !== (bPre === null)) return aPre === null ? 1 : -1;
  // Both pre-releases: compare identifiers per semver §11 — numeric ones
  // numerically ("beta.10" > "beta.2"), otherwise lexically, and a longer
  // list wins when every shared identifier is equal ("beta.1" > "beta").
  if (aPre !== null && bPre !== null) {
    const n = Math.min(aPre.length, bPre.length);
    for (let i = 0; i < n; i++) {
      const x = aPre[i];
      const y = bPre[i];
      const xNum = /^\d+$/.test(x);
      const yNum = /^\d+$/.test(y);
      if (xNum && yNum) {
        const d = parseInt(x, 10) - parseInt(y, 10);
        if (d !== 0) return d;
      } else if (xNum !== yNum) {
        return xNum ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    if (aPre.length !== bPre.length) return aPre.length - bPre.length;
  }
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

  // The conventional `skills/` directory is ALWAYS a candidate; declared paths
  // are added to it rather than replacing it.
  //
  // Codex review of #384 caught the replacement version as a regression. A
  // plugin with both `skills/foo/SKILL.md` and `"skills": "./extra"` would have
  // had its standard skills silently dropped — skills the walk listed correctly
  // *before* this feature existed. Whichever way Claude Code resolves the
  // manifest, additive is the only version that cannot lose a skill Minder was
  // already showing, and a catalog over-listing by one directory is a far
  // cheaper error than one that quietly stops listing.
  const candidates = ["skills"];
  if (typeof declared === "string") candidates.push(declared);
  else if (Array.isArray(declared)) {
    for (const p of declared) if (typeof p === "string") candidates.push(p);
  }

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
