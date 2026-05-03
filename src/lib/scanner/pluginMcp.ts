import { promises as fs } from "fs";
import path from "path";
import { McpServer } from "../types";
import { loadInstalledPlugins } from "../indexer/walkPlugins";
import type { InstalledPlugin } from "../indexer/types";
import { parseMcpServers } from "./mcpServers";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Read plugin-bundled MCP servers from each installed plugin's
 * `<installPath>/.mcp.json`.
 *
 * Per Claude Code's plugin spec (https://code.claude.com/docs/en/plugins),
 * plugin-bundled MCP servers are declared in a top-level `.mcp.json` at
 * the plugin root — NOT inline in `.claude-plugin/plugin.json` (the
 * manifest holds metadata only: name, version, description, author).
 * That's why we skip reading plugin.json for MCP entries.
 *
 * Each server's `sourcePath` points at the plugin's own `.mcp.json` so
 * the UI can attribute the source back to the plugin install location.
 *
 * Fails open: missing file or unreadable plugin install yields zero
 * entries for that plugin without affecting the others.
 *
 * `installed` may be passed in by callers that already walked the
 * plugin registry (e.g. `getUserConfig` shares one walk between this
 * reader and the plugins-info builder); when omitted, we walk it
 * ourselves so standalone callers still work.
 */
export async function readPluginScopeMcp(
  installed?: InstalledPlugin[],
): Promise<McpServer[]> {
  const plugins = installed ?? (await loadInstalledPlugins());
  if (plugins.length === 0) return [];

  const perPlugin = await Promise.all(
    plugins.map((p) => readOnePluginMcp(p.installPath)),
  );
  return perPlugin.flat();
}

async function readOnePluginMcp(installPath: string): Promise<McpServer[]> {
  const file = path.join(installPath, ".mcp.json");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const doc = tryParseJsonc<{ mcpServers?: unknown }>(raw);
    if (!doc?.mcpServers) return [];
    return parseMcpServers(doc.mcpServers, "plugin", file);
  } catch {
    return [];
  }
}
