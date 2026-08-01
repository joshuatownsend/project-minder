import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { getUserConfig } from "../userConfigCache";
import { getAdapter } from "../adapters";
import { resolveGeminiContextFileName } from "../indexer/instructions";
import type { DriftHarness, DriftItem, DriftKind, HarnessInventory } from "./types";

/**
 * Builds each harness's inventory by reading its config home (impure half of
 * the drift detector; `compare.ts` is the pure half).
 *
 * Every read here is best-effort. A harness home that doesn't exist, a config
 * file that won't parse, a permissions error — all resolve to an inventory
 * marked `present: false` or one with fewer items, never a throw. Drift
 * detection runs inside a scan; it must not be able to fail one.
 */

/** Root instruction files all key to this, so `CLAUDE.md` ≡ `AGENTS.md`. */
const ROOT_INSTRUCTION_KEY = "(root)";

/** Bound on directory listings so a pathological home can't stall a scan. */
const MAX_ENTRIES = 500;

function resolveHome(envVar: string, dirName: string): string {
  const env = process.env[envVar];
  return typeof env === "string" && env.trim()
    ? path.resolve(env.trim())
    : path.join(os.homedir(), dirName);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

type EntryKind = "dir" | "file" | "skip";

/**
 * Classify a directory entry, resolving symlinks.
 *
 * `readdir({ withFileTypes: true })` reports a symlink as `isSymbolicLink()`
 * and *never* as `isDirectory()`/`isFile()`, so a type check alone drops every
 * linked entry. That is not hypothetical here: 24 of 57 skills under
 * `~/.claude/skills` are stow-style links into `~/.agents/skills`. Dropping
 * them would be worse than undercounting — a skill missing from Claude's
 * inventory but present in Codex gets reported as missing *from Claude*,
 * telling the user to install something they already have. `fs.stat` follows
 * the link; a broken one throws and is skipped.
 */
async function classify(dir: string, entry: {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): Promise<EntryKind> {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return "skip";
  try {
    const target = await fs.stat(path.join(dir, entry.name));
    return target.isDirectory() ? "dir" : target.isFile() ? "file" : "skip";
  } catch {
    return "skip"; // dangling link
  }
}

async function readEntries(dir: string): Promise<{ name: string; kind: EntryKind }[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // Filter and SORT before capping. Capping the raw readdir output meant
  // dotfiles could consume slots that real entries needed, and the surviving
  // subset depended on filesystem order — so in a large directory the drift
  // report could flap between runs without anything changing on disk.
  const bounded = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
  const kinds = await Promise.all(bounded.map((e) => classify(dir, e)));
  return bounded.map((e, i) => ({ name: e.name, kind: kinds[i] }));
}

/**
 * List a skills directory. Both layouts count as one skill: a directory
 * containing `SKILL.md` (bundled) and a bare `.md` file (standalone) — the
 * same two shapes `walkSkillsRoot` handles, so a Claude standalone skill and
 * a Codex bundled one of the same name compare equal.
 *
 * A directory WITHOUT a `SKILL.md` is not a skill. The canonical walker
 * checks for that file and skips the directory when it is absent; treating
 * every subdirectory as an installed skill made ordinary scratch folders
 * (and, on some layouts, shared asset directories) show up as "missing from
 * Codex" — a finding telling the user to install something that was never a
 * skill in the first place.
 *
 * @internal Exported for vitest.
 */
export async function listSkills(dir: string, kind: DriftKind = "skill"): Promise<DriftItem[]> {
  const entries = await readEntries(dir);
  const items: DriftItem[] = [];
  const bundled = await Promise.all(
    entries.map(async (e) =>
      e.kind === "dir" ? await exists(path.join(dir, e.name, "SKILL.md")) : false
    )
  );

  for (const [i, entry] of entries.entries()) {
    let name: string;
    if (entry.kind === "dir") {
      if (!bundled[i]) continue;
      name = entry.name;
    } else if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
      name = entry.name.slice(0, -3);
    } else {
      continue;
    }
    items.push({ kind, key: name.toLowerCase(), name });
  }
  return items;
}

/** List a `rules/` directory as instruction items, keyed by basename.
 *  @internal Exported for vitest. */
export async function listRules(dir: string): Promise<DriftItem[]> {
  const items: DriftItem[] = [];
  for (const entry of await readEntries(dir)) {
    if (entry.kind !== "file") continue;
    const base = entry.name.replace(/\.(md|rules|txt)$/i, "");
    items.push({ kind: "instruction", key: base.toLowerCase(), name: entry.name });
  }
  return items;
}

async function rootInstruction(file: string): Promise<DriftItem[]> {
  if (!(await exists(file))) return [];
  return [{ kind: "instruction", key: ROOT_INSTRUCTION_KEY, name: path.basename(file) }];
}

/** Fingerprint an MCP server by how it launches, not by how it's named. */
function mcpSignature(spec: {
  command?: unknown;
  args?: unknown;
  url?: unknown;
}): string | undefined {
  if (typeof spec.url === "string" && spec.url) return spec.url;
  if (typeof spec.command !== "string" || !spec.command) return undefined;
  const args = Array.isArray(spec.args) ? spec.args.filter((a) => typeof a === "string") : [];
  return [spec.command, ...args].join(" ");
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function claudeInventory(): Promise<HarnessInventory> {
  // Deliberately NOT `CLAUDE_CONFIG_DIR`-aware. `getUserConfig()` — the
  // source of the MCP half below — reads `~/.claude` and `~/.claude.json`
  // unconditionally, so honouring the override here produced a MIXED
  // inventory: skills and instructions from the override, MCP servers from
  // the default home. That yields both false "missing" findings and false
  // conflicts. Claiming no support is honest; claiming half of it is not.
  const home = path.join(os.homedir(), ".claude");
  const present = await exists(home);
  const items: DriftItem[] = [];

  if (present) {
    const userCfg = await getUserConfig().catch(() => null);
    for (const server of userCfg?.mcpServers.servers ?? []) {
      // Plugin- and Desktop-scope servers are not the user's own harness
      // config: a plugin owns its servers, and Claude Desktop is a separate
      // application. Reporting either as "missing from Codex" would be
      // asking the user to replicate something they never wrote.
      if (server.source !== "user" && server.source !== "managed") continue;
      if (server.disabled) continue;
      items.push({
        kind: "mcp",
        key: server.name.toLowerCase(),
        name: server.name,
        signature: mcpSignature(server),
      });
    }

    const [skills, rules, root] = await Promise.all([
      listSkills(path.join(home, "skills")),
      listRules(path.join(home, "rules")),
      rootInstruction(path.join(home, "CLAUDE.md")),
    ]);
    items.push(...skills, ...rules, ...root);
  }

  return {
    harness: "claude",
    displayName: "Claude Code",
    present,
    supports: ["mcp", "skill", "instruction"],
    items,
    home,
  };
}

// ─── Codex ───────────────────────────────────────────────────────────────────

/** Pull `[mcp_servers.<name>]` out of an already-parsed, redacted config.toml. */
export function codexMcpItems(config: unknown): DriftItem[] {
  if (!config || typeof config !== "object") return [];
  const table = (config as Record<string, unknown>).mcp_servers;
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];

  const items: DriftItem[] = [];
  for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const spec = raw as Record<string, unknown>;
    items.push({
      kind: "mcp",
      key: name.toLowerCase(),
      name,
      signature: mcpSignature(spec),
    });
  }
  return items;
}

async function codexInventory(): Promise<HarnessInventory> {
  const home = resolveHome("CODEX_HOME", ".codex");
  const present = await exists(home);
  const items: DriftItem[] = [];

  if (present) {
    // The Codex adapter already reads and redacts `config.toml`; reusing it
    // keeps one parser and one redaction path rather than a second reader
    // that could forget to strip `[mcp_servers.X.env]` secrets.
    const adapter = getAdapter("codex");
    if (adapter?.readConfig) {
      try {
        const cfg = await adapter.readConfig();
        items.push(...codexMcpItems(cfg.config));
      } catch {
        // Unparseable config is already surfaced by the adapters page.
      }
    }

    const [skills, rules, root] = await Promise.all([
      listSkills(path.join(home, "skills")),
      listRules(path.join(home, "rules")),
      rootInstruction(path.join(home, "AGENTS.md")),
    ]);
    items.push(...skills, ...rules, ...root);
  }

  return {
    harness: "codex",
    displayName: "Codex",
    present,
    supports: ["mcp", "skill", "instruction"],
    items,
    home,
  };
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

/** `mcpServers` out of Gemini's `settings.json`. */
export function geminiMcpItems(settings: unknown): DriftItem[] {
  if (!settings || typeof settings !== "object") return [];
  const table = (settings as Record<string, unknown>).mcpServers;
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];

  const items: DriftItem[] = [];
  for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    items.push({
      kind: "mcp",
      key: name.toLowerCase(),
      name,
      signature: mcpSignature(raw as Record<string, unknown>),
    });
  }
  return items;
}

async function geminiInventory(): Promise<HarnessInventory> {
  const home = resolveHome("GEMINI_HOME", ".gemini");
  const present = await exists(home);
  const items: DriftItem[] = [];

  if (present) {
    try {
      const raw = await fs.readFile(path.join(home, "settings.json"), "utf-8");
      items.push(...geminiMcpItems(JSON.parse(raw)));
    } catch {
      // Absent or malformed settings — no MCP items, not an error.
    }

    // Gemini CLI lets the global context file be renamed via
    // `context.fileName` (or the legacy flat `contextFileName`). Hardcoding
    // GEMINI.md meant a user who renamed it got a false finding that Claude's
    // and Codex's root instructions were missing from Gemini. Reuses the
    // resolver the instructions indexer already ships.
    const contextFile = await resolveGeminiContextFileName(home).catch(() => "GEMINI.md");
    const [skills, root] = await Promise.all([
      listSkills(path.join(home, "skills")),
      rootInstruction(path.join(home, contextFile)),
    ]);
    items.push(...skills, ...root);
  }

  return {
    harness: "gemini",
    displayName: "Gemini CLI",
    present,
    // No `rules/` directory concept, but the root `GEMINI.md` is an
    // instruction file, so the kind still participates.
    supports: ["mcp", "skill", "instruction"],
    items,
    home,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const BUILDERS: Record<DriftHarness, () => Promise<HarnessInventory>> = {
  claude: claudeInventory,
  codex: codexInventory,
  gemini: geminiInventory,
};

/**
 * Build inventories for the requested harnesses, concurrently.
 *
 * `enabled` comes from `config.enabledAdapters`. Claude is always included:
 * it is the harness Minder is built around, and a drift report that could
 * only compare Codex against Gemini would be missing the interesting axis.
 */
export async function collectInventories(enabled: string[]): Promise<HarnessInventory[]> {
  const wanted = new Set<DriftHarness>(["claude"]);
  for (const id of enabled) {
    if (id === "codex" || id === "gemini") wanted.add(id);
  }
  return Promise.all([...wanted].map((id) => BUILDERS[id]()));
}
