/**
 * Shared server_id construction for MCP security scanner.
 * Mirrors mcp_servers.id convention: project scope → `project:<slug>:<name>`, local scope → `local:<slug>:<name>`,
 * all other scopes → `user:<name>`.
 *
 * Kept in a dependency-free module so both the server-side scanner and
 * the client-side ConfigBrowser can import it without bundling Node APIs.
 */
// JSON allows an escaped lone surrogate in a key, and encodeURIComponent throws on one: a single hostile
// server name must not abort the whole scan, so malformed code units are replaced first.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function encodePart(s: string): string {
  return encodeURIComponent(s.replace(LONE_SURROGATE, "�"));
}

export function buildServerId(source: string, name: string, projectSlug?: string): string {
  // Every component is URI-encoded, so the ":" separators are unambiguous and a slug or server name of
  // `user`, `local:x`, … cannot make one scope's id equal another's.
  const n = encodePart(name);
  if (!projectSlug) return `user:${n}`;
  const slug = encodePart(projectSlug);
  if (source === "local") return `local:${slug}:${n}`;
  return source === "project" ? `project:${slug}:${n}` : `user:${n}`;
}
