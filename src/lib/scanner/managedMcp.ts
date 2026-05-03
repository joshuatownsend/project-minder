import { promises as fs } from "fs";
import { McpServer } from "../types";
import { parseMcpServers } from "./mcpServers";
import { tryParseJsonc } from "./util/jsonc";

/**
 * Resolve the platform-specific managed-mcp.json path. Per Claude Code
 * docs (https://code.claude.com/docs/en/mcp#managed-mcp-configuration):
 *   - macOS:    /Library/Application Support/ClaudeCode/managed-mcp.json
 *   - Linux/WSL: /etc/claude-code/managed-mcp.json
 *   - Windows:  C:\Program Files\ClaudeCode\managed-mcp.json
 *
 * The Windows `C:\ProgramData\` path mentioned in older docs is
 * deprecated; we intentionally don't probe it.
 */
function getManagedMcpPath(): string | null {
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  }
  // Linux + WSL share the /etc path per Claude Code docs.
  return "/etc/claude-code/managed-mcp.json";
}

/**
 * Read MCP servers from the system-level `managed-mcp.json` (admin-deployed,
 * exclusive-control configuration). Same schema as a standard `.mcp.json`.
 *
 * Fails open on ENOENT and EACCES — these are the *expected* states on
 * machines without an admin-managed deployment, so we deliberately
 * suppress them to avoid noise. Genuine corruption (malformed JSON)
 * also yields `[]`; the failure surfaces only as an empty list, not
 * as a thrown exception (read paths in Project Minder must never block
 * dashboard rendering).
 */
export async function readManagedScopeMcp(): Promise<McpServer[]> {
  const filePath = getManagedMcpPath();
  if (!filePath) return [];

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const doc = tryParseJsonc<{ mcpServers?: unknown }>(raw);
  if (!doc?.mcpServers) return [];

  return parseMcpServers(doc.mcpServers, "managed", filePath);
}
