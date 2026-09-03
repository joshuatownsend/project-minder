import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { partitionClaudeHomes, getPrimaryClaudeHome, homeDedupeKey } from "@/lib/claudeHome";
import { normalizePathKey } from "@/lib/platform";
import { parseFrontmatter } from "@/lib/indexer/parseFrontmatter";
import { compareSemver } from "@/lib/indexer/walkPlugins";
import type { MinderConfig } from "@/lib/types";
import type { EnvAgent, EnvPlugin, EnvSkill, EnvironmentHome, EnvironmentsPayload } from "./diff";

/**
 * Per-home inventory for the Environments comparison.
 *
 * A deliberately shallow reader, separate from the catalog indexer
 * (`src/lib/indexer/`). The catalog is bound to this machine's home all the
 * way down: `loadInstalledPlugins` reads `~/.claude/plugins/installed_plugins.json`
 * and then walks each plugin's `installPath` — an absolute path in the
 * registry's own filesystem, which for a WSL home is a Linux path that is
 * meaningless from Windows. Teaching the catalog a home dimension is a real
 * change (a `home` parameter through `loadCatalog`, the walkers, the route
 * caches, and a `homeKey` on every entry); tracked as #553. This
 * reader answers the narrower question the Environments tab asks — what is
 * installed WHERE — without descending into any plugin, and so needs nothing
 * but the home directory itself.
 *
 * Reads only homes `partitionClaudeHomes` reports readable: touching a home
 * inside a stopped WSL distro would auto-start the VM (the never-wake
 * invariant, #307/#308). Every read is tolerant — a missing directory or an
 * unparseable file yields an empty list, never a throw, because one broken
 * home must not blank the comparison for the others.
 */

const MD = /\.md$/i;

/**
 * Directory entries classified through `stat` (which follows links) rather
 * than the Dirent flags: a skill or agent installed by symlinking a directory
 * into `skills/` reports `isDirectory() === false` on its Dirent, and the
 * catalog's `walkSkillsRoot` accepts that layout, so this reader must too or
 * the Environments tab reports the skill missing from that home (Codex on
 * #554). A dangling link classifies as neither and is skipped.
 */
async function readDir(dir: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; isDirectory: boolean; isFile: boolean }[] = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      out.push({ name, isDirectory: st.isDirectory(), isFile: st.isFile() });
    } catch {
      // dangling symlink or a race with deletion — not an entry
    }
  }
  return out;
}

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

async function frontmatterName(file: string): Promise<string | undefined> {
  try {
    const { fm } = parseFrontmatter(await fs.readFile(file, "utf-8"));
    return typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Same cap as the catalog's agent walker: `readDir` follows links, so an
 *  unbounded recursion could loop through a link cycle or wander far outside
 *  the root (Copilot on #554). */
const MAX_AGENT_DEPTH = 6;

/** `*.md` files under one agents root, recursively; slug is the relative path sans `.md`. */
async function readAgentsRoot(root: string): Promise<EnvAgent[]> {
  const out: EnvAgent[] = [];
  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > MAX_AGENT_DEPTH) return;
    for (const entry of await readDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full, `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.isFile && MD.test(entry.name)) {
        out.push({ slug: `${prefix}${entry.name.replace(MD, "")}`, name: await frontmatterName(full) });
      }
    }
  }
  await walk(root, "", 0);
  return out;
}

/**
 * Both agent layouts the catalog accepts: `<home>/agents` and the sibling
 * `~/.agents/agents` beside the `.claude` directory (`walkInstalledAgents`).
 * On a slug collision the `.claude` copy wins, as in `loadCatalog`.
 */
async function readAgents(home: string): Promise<EnvAgent[]> {
  const [claude, installed] = await Promise.all([
    readAgentsRoot(path.join(home, "agents")),
    readAgentsRoot(path.join(path.dirname(home), ".agents", "agents")),
  ]);
  const seen = new Set(claude.map((a) => a.slug));
  return [...claude, ...installed.filter((a) => !seen.has(a.slug))].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Skills under `<home>/skills` (and `skills-disabled`): a directory holding a
 * `SKILL.md` is a bundled skill named by the directory; a bare `*.md` file is a
 * standalone skill named by its stem — the two layouts `walkSkills` accepts.
 */
async function readSkillsRoot(root: string, disabled: boolean): Promise<EnvSkill[]> {
  const out: EnvSkill[] = [];
  for (const entry of await readDir(root)) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory) {
      const skillMd = path.join(full, "SKILL.md");
      try {
        await fs.access(skillMd);
      } catch {
        continue;
      }
      out.push({ slug: entry.name, name: await frontmatterName(skillMd), disabled });
    } else if (entry.isFile && MD.test(entry.name)) {
      out.push({ slug: entry.name.replace(MD, ""), name: await frontmatterName(full), disabled });
    }
  }
  return out;
}

async function readSkills(home: string): Promise<EnvSkill[]> {
  const [active, disabled] = await Promise.all([
    readSkillsRoot(path.join(home, "skills"), false),
    readSkillsRoot(path.join(home, "skills-disabled"), true),
  ]);
  return [...active, ...disabled].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Installed plugins from the registry file alone — never the install paths,
 * which are absolute in the home's own filesystem (see module header).
 * Highest version wins when a key carries several installs, using the same
 * `compareSemver` as `loadInstalledPlugins` so the two surfaces agree.
 */
async function readPlugins(home: string): Promise<EnvPlugin[]> {
  const doc = await readJson(path.join(home, "plugins", "installed_plugins.json"));
  const plugins = doc?.plugins;
  if (!isPlainObject(plugins)) return [];
  const out: EnvPlugin[] = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs) || installs.length === 0) continue;
    const lastAt = id.lastIndexOf("@");
    const name = lastAt > 0 ? id.slice(0, lastAt) : id;
    const marketplace = lastAt > 0 ? id.slice(lastAt + 1) : "";
    const versions = installs
      .map((i) => (i && typeof i === "object" ? (i as { version?: unknown }).version : undefined))
      .filter((v): v is string => typeof v === "string")
      .sort((a, b) => compareSemver(b, a));
    out.push({ id, name, marketplace, version: versions[0] });
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

/** Inventory one home. Exported for tests, which point it at a temp directory. */
export async function readHomeInventory(home: string, primary: boolean): Promise<EnvironmentHome> {
  const [agents, skills, plugins, mcpServers] = await Promise.all([
    readAgents(home),
    readSkills(home),
    readPlugins(home),
    readMcpServerNames(home),
  ]);
  return { key: environmentHomeKey(home), path: home, primary, agents, skills, plugins, mcpServers };
}

export async function loadEnvironments(config: MinderConfig): Promise<EnvironmentsPayload> {
  const { readable, unavailable } = await partitionClaudeHomes(config);
  const primaryKey = homeDedupeKey(getPrimaryClaudeHome());
  const homes = await Promise.all(
    readable.map((home) => readHomeInventory(home, homeDedupeKey(home) === primaryKey))
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
