import type { McpServerStats } from "@/lib/usage/types";

/**
 * Parses an MCP tool name to extract server and tool name.
 *
 * MCP tool names follow the pattern: mcp__<server>__<tool>
 * where the tool name may contain additional __ separators.
 *
 * @param toolName - The full tool name to parse
 * @returns Object with server and tool, or null if not an MCP tool
 */
export function parseMcpTool(
  toolName: string
): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) {
    return null;
  }

  const segments = toolName.split("__");

  // Need at least 3 segments: ["mcp", serverName, toolName...]
  if (segments.length < 3) {
    return null;
  }

  const server = segments[1];
  const tool = segments.slice(2).join("__");

  return { server, tool };
}

/**
 * Groups MCP tool calls by server and counts usage per tool.
 *
 * @param toolCalls - Array of tool calls with name property
 * @returns Array of MCP server statistics, sorted by totalCalls descending
 */
export function groupMcpCalls(
  toolCalls: { name: string }[]
): McpServerStats[] {
  const serverMap = new Map<string, Record<string, number>>();

  for (const call of toolCalls) {
    const parsed = parseMcpTool(call.name);
    if (!parsed) continue;

    const { server, tool } = parsed;

    if (!serverMap.has(server)) {
      serverMap.set(server, {});
    }

    const tools = serverMap.get(server)!;
    tools[tool] = (tools[tool] || 0) + 1;
  }

  // Convert to McpServerStats array and sort by totalCalls descending
  const results: McpServerStats[] = Array.from(serverMap.entries()).map(
    ([server, tools]) => {
      const totalCalls = Object.values(tools).reduce((sum, count) => sum + count, 0);
      return { server, tools, totalCalls };
    }
  );

  results.sort((a, b) => b.totalCalls - a.totalCalls);

  return results;
}
