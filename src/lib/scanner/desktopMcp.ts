import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { McpServer } from "../types";
import { parseMcpServers } from "./mcpServers";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Resolve the platform-specific Claude Desktop config path.
 *
 * Claude Desktop is only published for macOS and Windows
 * (https://modelcontextprotocol.io/quickstart/user). On Linux we return
 * `null` so the read becomes a no-op. Returning a path doesn't mean the
 * file exists — the reader fails open on ENOENT/EACCES.
 */
function getDesktopConfigPath(): string | null {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null;
}

/**
 * Read MCP servers from Claude Desktop's config (separate product from
 * Claude Code, but Claude Code can surface Desktop-configured servers
 * for cross-tool visibility).
 *
 * Schema is identical to Claude Code's `.mcp.json`: top-level
 * `mcpServers` keyed by name, with `command`/`args`/`env`/`url`/`type`
 * per entry.
 *
 * Fails open on ENOENT, EACCES, or malformed JSON: returns `[]`.
 * Fails open on Linux (no published Desktop client): returns `[]`.
 */
export async function readDesktopScopeMcp(): Promise<McpServer[]> {
  const filePath = getDesktopConfigPath();
  if (!filePath) return [];

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const doc = tryParseJsonc<{ mcpServers?: unknown }>(raw);
  if (!doc?.mcpServers) return [];

  return parseMcpServers(doc.mcpServers, "desktop", filePath);
}
