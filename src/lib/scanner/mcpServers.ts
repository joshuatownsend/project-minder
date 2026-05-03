import { promises as fs } from "fs";
import path from "path";
import { McpServer, McpServersInfo, McpSource, McpTransport } from "../types";
import { tryParseJsonc } from "./util/jsonc";
import { readLocalScopeMcpFromClaudeJson } from "./claudeJsonMcp";

/** Read MCP entries that apply to one project: project-scope from
 *  `.mcp.json` plus local-scope from `~/.claude.json`'s
 *  `projects[<path>].mcpServers` block. Returns undefined when neither
 *  source has entries (so callers that test for presence still work).
 *
 *  Local-scope entries are tagged `source: "local"` and carry the
 *  `~/.claude.json` path as their sourcePath — `applyMcp` rejects
 *  applies of `local` source (read-only), so this is purely visibility. */
export async function scanMcpServers(
  projectPath: string
): Promise<McpServersInfo | undefined> {
  const file = path.join(projectPath, ".mcp.json");
  let projectScope: McpServer[] = [];
  try {
    const raw = await fs.readFile(file, "utf-8");
    const doc = tryParseJsonc<{ mcpServers?: Record<string, unknown> }>(raw);
    if (doc?.mcpServers) {
      projectScope = parseMcpServers(doc.mcpServers, "project", file);
    }
  } catch {
    // No project-level .mcp.json — fall through to local-scope check.
  }

  const localScope = await readLocalScopeMcpFromClaudeJson(projectPath);
  const servers = [...projectScope, ...localScope];
  if (servers.length === 0) return undefined;
  return { servers };
}

export function parseMcpServers(
  map: unknown,
  source: McpSource,
  sourcePath: string
): McpServer[] {
  if (!map || typeof map !== "object") return [];
  const out: McpServer[] = [];

  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as {
      command?: unknown;
      args?: unknown;
      url?: unknown;
      type?: unknown;
      env?: unknown;
    };

    const command = typeof entry.command === "string" ? entry.command : undefined;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    const declared =
      typeof entry.type === "string" ? entry.type.toLowerCase() : "";

    let transport: McpTransport = "unknown";
    if (declared === "stdio" || declared === "http" || declared === "sse") {
      transport = declared;
    } else if (command) {
      transport = "stdio";
    } else if (url) {
      transport = "http";
    }

    const args = Array.isArray(entry.args)
      ? (entry.args.filter((a) => typeof a === "string") as string[])
      : undefined;

    const envKeys =
      entry.env && typeof entry.env === "object"
        ? Object.keys(entry.env as Record<string, unknown>)
        : undefined;

    out.push({
      name,
      transport,
      command,
      args,
      url,
      envKeys: envKeys && envKeys.length > 0 ? envKeys : undefined,
      source,
      sourcePath,
    });
  }

  return out;
}
