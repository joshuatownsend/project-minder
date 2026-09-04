import "server-only";
import { promises as fs } from "fs";
import path from "path";
import {
  partitionClaudeHomes,
  getPrimaryClaudeHome,
  homeDedupeKey,
  scopeMappingsToHome,
} from "@/lib/claudeHome";
import { normalizePathKey } from "@/lib/platform";
import { resolvePluginInstallPath, selectPluginInstall } from "@/lib/indexer/walkPlugins";
import type { MinderConfig, PathMapping } from "@/lib/types";
import type { EnvPlugin, EnvironmentHome, EnvironmentsPayload } from "./diff";

/**
 * Per-home inventory for the Environments comparison — the part the catalog
 * does not cover.
 *
 * Before #553 this reader also listed each home's agents and skills, because
 * the catalog indexer was bound to this machine's home. The catalog now takes
 * a `home` (`loadCatalog({ home })`, `/api/agents?home=`, `/api/skills?home=`)
 * and carries descriptions and plugin-provided entries, so the Environments
 * tab reads those from it and this module is reduced to: installed plugins
 * from the registry file, MCP server names, and which homes could not be
 * read. Plugins stay here rather than in the catalog response because the
 * catalog lists a plugin's CONTENTS — a plugin with no agents or skills would
 * otherwise vanish from the comparison — and because this is where the
 * "contents unreadable" fact (an `installPath` no mapping covers) is best
 * attached.
 *
 * Reads only homes `partitionClaudeHomes` reports readable: touching a home
 * inside a stopped WSL distro would auto-start the VM (the never-wake
 * invariant, #307/#308). Every read is tolerant — a missing directory or an
 * unparseable file yields an empty list, never a throw, because one broken
 * home must not blank the comparison for the others.
 */

/** A JSON object, not an array: `Object.keys([...])` would yield indices as names. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Installed plugins from the registry file alone. When a key carries several
 * installs, the SAME record the catalog reads wins (`selectPluginInstall`,
 * highest semver), and both `version` and `unresolved` come from that one
 * record — the catalog walks only that install, so readability judged over
 * any other record would call a plugin readable while its catalog column is
 * empty (Copilot + Codex on #555). A registry entry is listed whether or not
 * its `installPath` resolves — `unresolved` records that its contents cannot
 * be read from here (the catalog's `resolvePluginInstallPath` rule), which is
 * a fact about THIS machine's view of the home, not about the install.
 */
async function readPlugins(
  home: string,
  resolve: { primary: boolean; mappings: PathMapping[] }
): Promise<EnvPlugin[]> {
  const doc = await readJson(path.join(home, "plugins", "installed_plugins.json"));
  const plugins = doc?.plugins;
  if (!isPlainObject(plugins)) return [];
  const out: EnvPlugin[] = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs) || installs.length === 0) continue;
    const lastAt = id.lastIndexOf("@");
    const name = lastAt > 0 ? id.slice(0, lastAt) : id;
    const marketplace = lastAt > 0 ? id.slice(lastAt + 1) : "";
    const records = installs
      .filter((i): i is Record<string, unknown> => isPlainObject(i))
      .map((i) => ({
        version: typeof i.version === "string" ? i.version : undefined,
        installPath: typeof i.installPath === "string" ? i.installPath : undefined,
      }));
    const winner = selectPluginInstall(records);
    // An entry with no install path at all has nothing to resolve.
    const unresolved =
      winner?.installPath !== undefined && resolvePluginInstallPath(winner.installPath, resolve).unresolved;
    out.push({ id, name, marketplace, version: winner?.version, ...(unresolved ? { unresolved: true } : {}) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * MCP server NAMES from the two user-scope sources: `<home>/settings.json` and
 * the sibling `.claude.json` beside the `.claude` directory. Names only — the
 * configs carry `env` blocks with API keys, and presence is all the diff needs.
 */
async function readMcpServerNames(home: string): Promise<string[]> {
  const [settings, claudeJson] = await Promise.all([
    readJson(path.join(home, "settings.json")),
    readJson(path.join(path.dirname(home), ".claude.json")),
  ]);
  const names = new Set<string>();
  for (const doc of [settings, claudeJson]) {
    const servers = doc?.mcpServers;
    if (isPlainObject(servers)) {
      for (const name of Object.keys(servers)) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * The join key for a home: `normalizePathKey(home)`, the same function
 * `resolveUsageHomeKey` uses to stamp `ProjectData.usageHomeKey`, so a group
 * location joins to its home by string equality. `homeDedupeKey` would NOT
 * match — it rewrites WSL homes to a `wsl://` form the scanner never emits.
 */
export function environmentHomeKey(home: string): string {
  return normalizePathKey(home);
}

/**
 * Inventory one home. Exported for tests, which point it at a temp directory.
 * `mappings` are the home's scoped `pathMappings` (`scopeMappingsToHome`),
 * used only to judge whether each plugin's contents are reachable from here.
 */
export async function readHomeInventory(
  home: string,
  primary: boolean,
  mappings: PathMapping[] = []
): Promise<EnvironmentHome> {
  const [plugins, mcpServers] = await Promise.all([
    readPlugins(home, { primary, mappings }),
    readMcpServerNames(home),
  ]);
  return { key: environmentHomeKey(home), path: home, primary, plugins, mcpServers };
}

export async function loadEnvironments(config: MinderConfig): Promise<EnvironmentsPayload> {
  const { readable, unavailable } = await partitionClaudeHomes(config);
  const primaryKey = homeDedupeKey(getPrimaryClaudeHome());
  const homes = await Promise.all(
    readable.map((home) => {
      const primary = homeDedupeKey(home) === primaryKey;
      return readHomeInventory(home, primary, primary ? [] : scopeMappingsToHome(home, config.pathMappings));
    })
  );
  return {
    homes,
    unavailable: unavailable.map((u) => ({
      key: environmentHomeKey(u.path),
      path: u.path,
      distro: u.distro,
      reason: u.reason,
    })),
  };
}
