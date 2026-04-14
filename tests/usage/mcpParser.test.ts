import { describe, it, expect } from "vitest";
import { parseMcpTool, groupMcpCalls } from "@/lib/usage/mcpParser";

describe("mcpParser", () => {
  describe("parseMcpTool", () => {
    it("parses valid MCP tool with simple server name", () => {
      const result = parseMcpTool("mcp__context7__query-docs");
      expect(result).toEqual({ server: "context7", tool: "query-docs" });
    });

    it("parses MCP tool with nested server name containing underscores", () => {
      const result = parseMcpTool(
        "mcp__plugin_context7_context7__resolve-library-id"
      );
      expect(result).toEqual({
        server: "plugin_context7_context7",
        tool: "resolve-library-id",
      });
    });

    it("parses MCP tool with tool name containing double underscores", () => {
      const result = parseMcpTool("mcp__server__tool__with__underscores");
      expect(result).toEqual({
        server: "server",
        tool: "tool__with__underscores",
      });
    });

    it("returns null for non-MCP tool", () => {
      const result = parseMcpTool("Read");
      expect(result).toBeNull();
    });

    it("returns null for MCP prefix with only 2 segments", () => {
      const result = parseMcpTool("mcp__only");
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = parseMcpTool("");
      expect(result).toBeNull();
    });

    it("returns null for string without mcp__ prefix", () => {
      const result = parseMcpTool("Bash");
      expect(result).toBeNull();
    });
  });

  describe("groupMcpCalls", () => {
    it("groups multiple tools by server and counts correctly", () => {
      const toolCalls = [
        { name: "mcp__context7__query-docs" },
        { name: "mcp__context7__resolve-library-id" },
        { name: "mcp__context7__query-docs" },
        { name: "mcp__plugin_context7_context7__resolve-library-id" },
        { name: "mcp__plugin_context7_context7__resolve-library-id" },
        { name: "mcp__plugin_context7_context7__resolve-library-id" },
        { name: "mcp__server3__tool1" },
        { name: "mcp__server3__tool1" },
        { name: "mcp__server3__tool1" },
        { name: "mcp__server3__tool1" },
      ];

      const result = groupMcpCalls(toolCalls);

      expect(result).toHaveLength(3);

      // First server should have highest totalCalls (sorted descending)
      expect(result[0]).toEqual({
        server: "server3",
        tools: {
          "tool1": 4,
        },
        totalCalls: 4,
      });

      // Next two both have 3 calls, order is implementation-dependent
      const remaining = result.slice(1);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((r) => r.server)).toContain("context7");
      expect(remaining.map((r) => r.server)).toContain("plugin_context7_context7");

      const context7 = remaining.find((r) => r.server === "context7");
      expect(context7).toEqual({
        server: "context7",
        tools: {
          "query-docs": 2,
          "resolve-library-id": 1,
        },
        totalCalls: 3,
      });

      const plugin = remaining.find((r) => r.server === "plugin_context7_context7");
      expect(plugin).toEqual({
        server: "plugin_context7_context7",
        tools: {
          "resolve-library-id": 3,
        },
        totalCalls: 3,
      });
    });

    it("returns empty array for no MCP tools", () => {
      const toolCalls = [{ name: "Read" }, { name: "Bash" }, { name: "Write" }];

      const result = groupMcpCalls(toolCalls);

      expect(result).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      const result = groupMcpCalls([]);

      expect(result).toEqual([]);
    });

    it("sorts by totalCalls descending", () => {
      const toolCalls = [
        { name: "mcp__server1__tool1" },
        { name: "mcp__server2__tool1" },
        { name: "mcp__server2__tool1" },
        { name: "mcp__server2__tool1" },
        { name: "mcp__server3__tool1" },
        { name: "mcp__server3__tool1" },
      ];

      const result = groupMcpCalls(toolCalls);

      expect(result).toHaveLength(3);
      expect(result[0].server).toBe("server2");
      expect(result[0].totalCalls).toBe(3);
      expect(result[1].server).toBe("server3");
      expect(result[1].totalCalls).toBe(2);
      expect(result[2].server).toBe("server1");
      expect(result[2].totalCalls).toBe(1);
    });

    it("mixes MCP and non-MCP tools correctly", () => {
      const toolCalls = [
        { name: "Read" },
        { name: "mcp__context7__query-docs" },
        { name: "Bash" },
        { name: "mcp__context7__query-docs" },
        { name: "Write" },
      ];

      const result = groupMcpCalls(toolCalls);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        server: "context7",
        tools: {
          "query-docs": 2,
        },
        totalCalls: 2,
      });
    });
  });
});
