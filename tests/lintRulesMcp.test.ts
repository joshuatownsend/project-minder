import { describe, it, expect } from "vitest";
import { runMcpRules } from "@/lib/lint/rules/mcp";
import type { McpServer } from "@/lib/types";

function makeServer(name: string, source: McpServer["source"], disabled = false): McpServer {
  return {
    name,
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    source,
    sourcePath: `.claude/mcp.json`,
    disabled,
  };
}

describe("runMcpRules — duplicate-server-name", () => {
  it("returns no findings for unique server names", () => {
    const servers: McpServer[] = [
      makeServer("github",   "project"),
      makeServer("postgres", "user"),
    ];
    expect(runMcpRules(servers)).toHaveLength(0);
  });

  it("flags a server name defined in two sources", () => {
    const servers: McpServer[] = [
      makeServer("github", "project"),
      makeServer("github", "user"),
    ];
    const findings = runMcpRules(servers);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("mcp/duplicate-server-name");
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].engine).toBe("vendored");
    expect(findings[0].title).toContain("github");
  });

  it("flags a server name defined in three sources", () => {
    const servers: McpServer[] = [
      makeServer("shared", "project"),
      makeServer("shared", "user"),
      makeServer("shared", "plugin"),
    ];
    const findings = runMcpRules(servers);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("shared");
  });

  it("flags servers with the same name in the same source (also a duplicate error)", () => {
    // Two entries with the same name in the same source file is a config error
    // (accidental duplication). The rule flags total entry count >= 2.
    const servers: McpServer[] = [
      makeServer("svc", "project"),
      makeServer("svc", "project"),
    ];
    const findings = runMcpRules(servers);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("mcp/duplicate-server-name");
  });

  it("ignores disabled servers in duplicate detection", () => {
    const servers: McpServer[] = [
      makeServer("svc", "project"),
      makeServer("svc", "user", true),   // disabled
    ];
    expect(runMcpRules(servers)).toHaveLength(0);
  });

  it("produces one finding per duplicate name even with three sources", () => {
    const servers: McpServer[] = [
      makeServer("a", "project"),
      makeServer("a", "user"),
      makeServer("a", "plugin"),
      makeServer("b", "project"),
      makeServer("b", "local"),
    ];
    expect(runMcpRules(servers)).toHaveLength(2);
  });
});
