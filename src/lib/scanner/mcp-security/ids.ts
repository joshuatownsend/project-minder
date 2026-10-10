/**
 * Shared server_id construction for MCP security scanner.
 * Mirrors mcp_servers.id convention: project scope → `<slug>:<name>`, local scope → `<slug>:local:<name>`,
 * all other scopes → `user:<name>`.
 *
 * Kept in a dependency-free module so both the server-side scanner and
 * the client-side ConfigBrowser can import it without bundling Node APIs.
 */
export function buildServerId(source: string, name: string, projectSlug?: string): string {
  if (!projectSlug) return `user:${name}`;
  // A project can define the same name in `.mcp.json` and in its local-scope entry; the two stay distinct.
  if (source === "local") return `${projectSlug}:local:${name}`;
  return source === "project" ? `${projectSlug}:${name}` : `user:${name}`;
}
