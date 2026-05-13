import type { LintFinding, McpServer } from "../../types";

/**
 * Vendored MCP lint rules — focused on cross-source issues the library CLI
 * cannot detect because it only scans a single project directory.
 */
export function runMcpRules(servers: McpServer[]): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...duplicateServerNames(servers));
  return findings;
}

/**
 * Flag MCP servers with the same name defined across multiple sources.
 * The last-scope-wins resolution in Claude Code is surprising — duplicates
 * suggest a leftover entry that should be cleaned up.
 */
function duplicateServerNames(servers: McpServer[]): LintFinding[] {
  const active = servers.filter((s) => !s.disabled);
  const byName = new Map<string, McpServer[]>();
  for (const s of active) {
    const bucket = byName.get(s.name) ?? [];
    bucket.push(s);
    byName.set(s.name, bucket);
  }

  const findings: LintFinding[] = [];
  for (const [name, dupes] of byName) {
    if (dupes.length < 2) continue;
    const sources = [...new Set(dupes.map((d) => d.source))].join(", ");
    findings.push({
      target: "mcp",
      code: "mcp/duplicate-server-name",
      severity: "P1",
      title: `MCP server "${name}" defined in multiple sources (${sources})`,
      fix: `Remove duplicate entries. Last-scope wins, but duplicates cause confusion and may load unintended versions.`,
      penalty: 5,
      engine: "vendored",
    });
  }
  return findings;
}
