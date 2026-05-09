/**
 * Shared server_id construction for MCP security scanner.
 * Mirrors mcp_servers.id convention: project scope → `<slug>:<name>`,
 * all other scopes → `user:<name>`.
 *
 * Kept in a dependency-free module so both the server-side scanner and
 * the client-side ConfigBrowser can import it without bundling Node APIs.
 */
export function buildServerId(source: string, name: string, projectSlug?: string): string {
  return source === "project" && projectSlug
    ? `${projectSlug}:${name}`
    : `user:${name}`;
}
