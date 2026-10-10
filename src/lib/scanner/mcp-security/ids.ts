/**
 * Shared server_id construction for MCP security scanner.
 * Mirrors mcp_servers.id convention: project scope → `project:<slug>:<name>`, local scope → `local:<slug>:<name>`,
 * all other scopes → `user:<name>`.
 *
 * Kept in a dependency-free module so both the server-side scanner and
 * the client-side ConfigBrowser can import it without bundling Node APIs.
 */
export function buildServerId(source: string, name: string, projectSlug?: string): string {
  // Every component is URI-encoded, so the ":" separators are unambiguous and a slug or server name of
  // `user`, `local:x`, … cannot make one scope's id equal another's.
  const n = encodeURIComponent(name);
  if (!projectSlug) return `user:${n}`;
  const slug = encodeURIComponent(projectSlug);
  if (source === "local") return `local:${slug}:${n}`;
  return source === "project" ? `project:${slug}:${n}` : `user:${n}`;
}
