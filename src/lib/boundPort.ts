/**
 * Single source of truth for "which port did this server actually bind, and
 * which loopback origins therefore count as same-origin?"
 *
 * Two independent security boundaries derive their allowlists from here:
 *
 *   - `src/proxy.ts` — the dashboard's Host/Origin check on `/api/*`
 *   - `src/lib/mcp/server.ts` — the MCP transport's DNS-rebinding protection
 *
 * They previously each carried their own copy, and the MCP one was pinned to a
 * literal 4100 while the proxy honored `process.env.PORT`. The result was a
 * dashboard that worked on a custom port but whose MCP endpoint 403'd every
 * request. Deriving both from this module makes that drift impossible.
 *
 * NOTE: deliberately free of `server-only` — `proxy.ts` may be evaluated in a
 * non-Node runtime and cannot import server-only modules.
 */

/** The port `pnpm dev` / `pnpm start` bind when nothing overrides them. */
export const DEFAULT_PORT = 4100;

/**
 * The port this process actually bound this run. `PORT` is set by the
 * standalone/sidecar entry — e.g. the tray passes its `MINDER_TRAY_PORT`
 * through as `PORT` when spawning the server (see `src-tauri/src/supervisor.rs`).
 *
 * Only the bound port is ever trusted — NOT the canonical 4100 as well.
 * Trusting :4100 on a server bound to (say) 4199 would let any other local
 * process serving a page on :4100 fetch the 4199 APIs cross-origin. (issue #283)
 */
export function resolveBoundPort(
  // Typed as just the one key this reads, not the full `NodeJS.ProcessEnv`:
  // Next augments that interface with required members (NODE_ENV), which would
  // force every caller and test to construct a whole environment to pass a port.
  env: { PORT?: string | undefined } = process.env as { PORT?: string | undefined }
): number {
  const raw = env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * The loopback host allowlist for a bound port — exactly the
 * `localhost` / `127.0.0.1` / `[::1]` trio on that port, and nothing else.
 */
export function buildAllowedHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

/**
 * The same trio as absolute `http://` origins, for consumers that compare
 * whole Origin header values rather than parsing out the host (the MCP SDK
 * transport takes origins, the proxy parses hosts).
 *
 * Always `http://` — this dashboard is loopback-only and never served over TLS.
 */
export function buildAllowedOrigins(port: number): string[] {
  return [...buildAllowedHosts(port)].map((host) => `http://${host}`);
}
