// ─── Claude config: hooks, MCP servers, plugins ──────────────────────────────

export type HookSource = "project" | "local" | "user" | "plugin";

// `satisfies Record<HookSource, ...>` is the compile-time prompt — adding a
// new HookSource member without extending this table is a type error. The
// inline string checks `s === "user"` we replaced silently returned false
// for new members; this table refuses to compile until you decide.
//
//   - toggleable:    round-trips via the sidecar (~/.claude/.minder/disabled-hooks.json)
//   - projectShared: git-tracked, can't be safely mutated from the dashboard
//                    (hooks are additive — see effectiveConfig.ts:106)
//
// `plugin` is owned by the plugin author and intentionally inert in both flags.
const HOOK_SOURCE_FLAGS = {
  project: { toggleable: false, projectShared: true },
  local:   { toggleable: true,  projectShared: false },
  user:    { toggleable: true,  projectShared: false },
  plugin:  { toggleable: false, projectShared: false },
} as const satisfies Record<HookSource, { toggleable: boolean; projectShared: boolean }>;

export function isToggleableHookSource(s: HookSource): s is "user" | "local" {
  return HOOK_SOURCE_FLAGS[s].toggleable;
}
export function isProjectSharedHookSource(s: HookSource): s is "project" {
  return HOOK_SOURCE_FLAGS[s].projectShared;
}

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookEntry {
  /** PreToolUse | PostToolUse | SessionStart | UserPromptSubmit | Stop | etc. */
  event: string;
  /** Tool/event matcher (e.g. "Edit|Write", "Bash"). Optional. */
  matcher?: string;
  commands: HookCommand[];
  source: HookSource;
  /** Absolute file path the entry came from — used for the future template-builder. */
  sourcePath: string;
}

export interface HooksInfo {
  entries: HookEntry[];
}

export type McpTransport = "stdio" | "http" | "sse" | "unknown";

/**
 * Where Project Minder read this MCP server from. Per Claude Code's
 * docs (https://code.claude.com/docs/en/settings):
 *
 *  - "project"  — `<project>/.mcp.json`
 *  - "user"     — top-level `mcpServers` in `~/.claude.json`, OR the
 *                 `mcpServers` key in `~/.claude/settings.json` (legacy
 *                 location, preserved because plugin scenarios can still
 *                 touch it)
 *  - "local"    — per-project entry in `~/.claude.json`
 *                 (`projects.<path>.mcpServers`); private to user, scoped
 *                 to one project
 *  - "plugin"   — `<plugin-root>/.mcp.json` of an installed plugin.
 *                 Per Claude Code's plugin spec, `plugin.json` is a
 *                 metadata-only manifest (name/version/description/author)
 *                 and is NOT read for MCP entries.
 *  - "desktop"  — Claude Desktop's `claude_desktop_config.json` (the
 *                 separate desktop app; importable via
 *                 `claude mcp add-from-claude-desktop`)
 *  - "managed"  — IT-deployed `managed-mcp.json` under the platform's
 *                 system directory
 *
 * Only "project" and "user" are write targets via the apply layer; the
 * other sources are READ-ONLY in Project Minder. applyMcp rejects
 * non-write sources explicitly so a misuse is loud.
 */
export type McpSource = "project" | "user" | "local" | "plugin" | "desktop" | "managed";

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Env variable KEY NAMES only — never values (avoid leaking secrets). */
  envKeys?: string[];
  source: McpSource;
  sourcePath: string;
  /** True when this server appears in `disabledMcpjsonServers` in the project's settings files. */
  disabled?: boolean;
}

export interface McpServersInfo {
  servers: McpServer[];
}

/** Live-health verdict for one configured MCP server.
 *
 *  - "up"      — reachable (http/sse) or launchable (stdio command resolves)
 *  - "down"    — unreachable (http/sse) or misconfigured (command missing)
 *  - "unknown" — no probe applies (disabled, unknown transport, probe error)
 */
export type McpHealthStatus = "up" | "down" | "unknown";

export interface McpHealth {
  name: string;
  transport: McpTransport;
  status: McpHealthStatus;
  /** Human-readable one-liner for the tooltip (e.g. "reachable (HTTP 200)"). */
  detail: string;
  /** How the verdict was reached — clarifies what "up" actually asserts.
   *  "http" = real reachability; "command" = launchability, NOT probed;
   *  "none" = not probed at all. */
  probeKind: "http" | "command" | "none";
  /** Unix ms when the probe ran; drives the cache TTL. */
  checkedAt: number;
}

export interface PluginEntry {
  name: string;
  marketplace: string;
  enabled: boolean;
  blocked: boolean;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  installPath?: string;
  gitCommitSha?: string;
  pluginRepoUrl?: string;
}

export interface PluginsInfo {
  plugins: PluginEntry[];
}

export interface OutputStyleEntry {
  /** Directory name under `.claude/output-styles/`. */
  name: string;
  /** Absolute path to the style's prompt markdown file. */
  promptPath: string;
  frontmatter: Record<string, unknown>;
}

export interface OutputStylesInfo {
  styles: OutputStyleEntry[];
}

export interface LspConfigInfo {
  /** Absolute path to the lsp.json file. */
  sourcePath: string;
  /** Raw parsed config — keys are language IDs, values are server configs. */
  config: Record<string, unknown>;
}

// ─── Plans ───────────────────────────────────────────────────────────────────

export interface PlanEntry {
  /** Filename without .md extension — stable identifier. */
  slug: string;
  /** Absolute path to the plan file. */
  path: string;
  /** Title from front-matter `title:` or first `# ` heading, else the slug. */
  title: string;
  /** Tags from front-matter `tags:` array. Empty when absent. */
  tags: string[];
  /** Session UUIDs found by regex in the plan body (heuristic). */
  relatedSessionIds: string[];
  mtime: string;
  sizeBytes: number;
}

/** Slash command discovered under .claude/commands/. Mirrors AgentEntry shape, minus tools/model. */
export interface CommandEntry {
  id: string;                    // command:<source>:<prefix>:<relPath>
  slug: string;                  // basename without .md
  name: string;                  // frontmatter.name or slug
  description?: string;
  source: "user" | "plugin" | "project";
  pluginName?: string;
  projectSlug?: string;
  category?: string;
  filePath: string;
  bodyExcerpt: string;
  frontmatter: Record<string, unknown>;
  mtime: string;
  ctime: string;
  /** Comma-separated `allowed-tools` frontmatter parsed into an array. */
  allowedTools?: string[];
  argumentHint?: string;
  isSymlink?: boolean;
  realPath?: string;
  provenance?: import("../indexer/types").Provenance;
  parseWarnings?: string[];
}
