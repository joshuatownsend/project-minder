/**
 * Shared server_id construction for MCP security scanner.
 * Mirrors mcp_servers.id convention: project scope → `project:<slug>:<name>`, local scope → `local:<slug>:<name>`,
 * all other scopes → `user:<name>`.
 *
 * Kept in a dependency-free module so both the server-side scanner and
 * the client-side ConfigBrowser can import it without bundling Node APIs.
 */

// JSON allows an escaped lone surrogate in a key, and encodeURIComponent throws on one: a single hostile
// server name must not abort the whole scan. Each lone code unit becomes `%uXXXX`, which encodeURIComponent
// never produces (a literal "%" is encoded as "%25"), so distinct names keep distinct ids.
const LONE_SURROGATE = /([\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;
function encodePart(s: string): string {
  return s
    .split(LONE_SURROGATE)
    .map((piece, i) =>
      i % 2 === 1 ? "%u" + piece.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") : encodeURIComponent(piece),
    )
    .join("");
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
