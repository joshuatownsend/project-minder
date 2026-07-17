import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Origin/Host protection for the local API surface (finding S1).
//
// Project Minder is a local-only, no-auth dashboard — see the header comment
// on src/app/api/sql/route.ts for the same "no auth by design" posture on
// that endpoint. No-auth is fine for a tool only your own machine can reach,
// but that assumption only holds if nothing *else* can reach it either. Two
// distinct browser-based threats close that gap, and this proxy (Next 16's
// rename of the middleware file convention) defends against both with two
// separate checks:
//
//   1. DNS rebinding (defended via Host). An attacker's page is served from
//      a domain whose DNS they control. The browser resolves it to a public
//      IP for the initial same-origin load, then the attacker flips the DNS
//      record to 127.0.0.1/localhost and the page's own JS re-requests
//      `http://<their-domain>:4100/api/...`. Because the browser now
//      connects straight to our loopback server, the raw TCP connection —
//      and therefore the `Host` header — arrives at OUR process. Requiring
//      `Host` to be one of the addresses this dashboard is actually served
//      on (localhost/127.0.0.1/::1 at port 4100) defeats this regardless of
//      HTTP method, which matters because a plain GET can already exfiltrate
//      data (e.g. `/api/sql` runs arbitrary read SELECTs over the local
//      index — see that route's header comment). Origin-only protection
//      would miss this: rebinding doesn't require a state-changing request.
//
//   2. Cross-site request forgery (defended via Origin, ALL methods).
//      Any other site open in your browser can fire a same-origin-policy-
//      legal "simple request" (e.g. a `Content-Type: text/plain` POST, which
//      skips CORS preflight) at `http://localhost:4100/api/...`, using your
//      browser as a confused deputy to drive state-changing endpoints
//      (dev-server start/stop, board mutations, widening `devRoots`, etc).
//      Browsers always attach an `Origin` header to cross-origin
//      fetch/XHR — page JS cannot suppress it — so we require it to match
//      the same host allowlist. This applies to GET/HEAD too: this dashboard
//      is same-origin-only, so a cross-origin browser fetch/XHR is never
//      legitimate regardless of method. This only catches requests that CARRY
//      an Origin (scripted fetch/XHR); an origin-less cross-site GET (e.g. an
//      `<img>` subresource) still passes, so side-effecting GETs were ALSO
//      removed at the source — the task dispatcher now starts at server boot
//      (instrumentation-node.ts), not on a GET to /api/tasks or /api/swarms.
//
//      If `Origin` is ABSENT, the request is allowed through this second
//      check (the Host check above still applies to it). Browser-driven
//      CSRF always carries an Origin header, so its absence means the
//      request isn't coming from a browser's fetch/XHR machinery at all —
//      it's curl, a local script, or another server-to-server caller (e.g.
//      the MCP server's own dev-server tools running in the same process).
//      Those callers have no "confused browser" to exploit, so there is no
//      CSRF vector to defend against, and demanding Origin from them would
//      simply break legitimate local tooling for zero security benefit.
//
// `/api/mcp` is skipped entirely. It already has its own DNS-rebinding
// protection via the MCP SDK's StreamableHTTP transport (`allowedHosts` /
// `allowedOrigins` in src/lib/mcp/server.ts), tuned to that transport's own
// session/protocol semantics. Double-guarding here risks disagreeing with
// the SDK's checks in some edge case and breaking the MCP transport outright
// for no added protection.
// ---------------------------------------------------------------------------

// Hosts/origins this dashboard is actually served on — all loopback, each
// carrying an explicit port. The port is what makes the Origin check
// trustworthy: a legit same-origin request always presents `localhost:<port>`
// (not bare `localhost`). Allowing a port-less `localhost` would let a page
// served from http://localhost/ (port 80 — a *different* origin) pass the
// Origin check and drive state-changing endpoints (CSRF); requiring the port
// closes that.
//
// The set is **derived strictly from the bound port** — the port the server
// actually bound this run (`process.env.PORT`, which the standalone/sidecar
// entry sets, e.g. the tray's `MINDER_TRAY_PORT`), defaulting to 4100 (what
// `pnpm dev`/`pnpm start` bind). Without the bound-port entries a browser
// opened at `http://localhost:<custom-port>` — which cannot spoof Host/Origin —
// would have every `/api/*` call 403'd, breaking the dashboard on any non-4100
// port. Only the bound port is trusted: NOT the canonical :4100 as well, because
// trusting :4100 on a server bound to (say) 4199 would let ANY other local
// process serving a page on :4100 fetch the 4199 APIs cross-origin. Default
// 4100 → identical to the pre-C1 behavior. Still loopback-only: no rebind
// surface, just the correct port. (issue #283)
//
// The MCP server's own allowlist (src/lib/mcp/server.ts) is separate — /api/mcp
// is skipped here and has its own transport-level DNS-rebind protection.
function resolveBoundPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 4100;
}

/**
 * Build the loopback host allowlist for a given bound port — exactly the
 * `localhost`/`127.0.0.1`/`[::1]` trio on that port, and nothing else. Exported
 * for unit testing the derived entries.
 */
export function buildAllowedHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

const ALLOWED_HOSTS = buildAllowedHosts(resolveBoundPort());

export interface EvaluateInput {
  method: string;
  host: string | null;
  origin: string | null;
  pathname: string;
}

export interface EvaluateResult {
  allow: boolean;
  reason?: string;
}

/**
 * Pure decision function extracted out of the Next.js proxy so it can
 * be unit-tested directly (no NextRequest/NextResponse construction needed).
 * See the file-header comment above for the two-layer rationale.
 *
 * `allowedHosts` defaults to the process-wide, port-aware set; it's a parameter
 * so tests can exercise the derived-port allowlist without mutating
 * `process.env.PORT`.
 */
export function evaluateRequest(
  {
    // `method` is part of EvaluateInput (and still passed by callers/tests) but
    // the allowlist now applies to every method, so it isn't read here.
    host,
    origin,
    pathname,
  }: EvaluateInput,
  allowedHosts: Set<string> = ALLOWED_HOSTS,
): EvaluateResult {
  // Only the API surface is guarded — everything else (pages, static
  // assets) is unaffected, and `config.matcher` below scopes the proxy
  // invocation to /api/* anyway; this check is a defensive second gate.
  if (!pathname.startsWith("/api/")) {
    return { allow: true };
  }

  // /api/mcp has its own DNS-rebinding protection via the MCP SDK transport
  // — don't double-guard it (see file header).
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    return { allow: true };
  }

  // Layer 1 — Host allowlist, ALL methods (including GET/HEAD). Defeats DNS
  // rebinding against read endpoints too (e.g. /api/sql).
  if (!host || !allowedHosts.has(host.toLowerCase())) {
    return { allow: false, reason: "host not allowed" };
  }

  // Layer 2 — Origin allowlist, applied to ALL methods (including GET/HEAD).
  // This dashboard is same-origin-only, so a cross-origin browser fetch/XHR
  // (which always carries an Origin) is never legitimate regardless of method —
  // block it. This catches scripted cross-origin requests; it does NOT stop an
  // origin-less cross-site GET (an `<img>` subresource sends no Origin), so
  // side-effecting GETs are removed at the source instead (the task dispatcher
  // starts at boot, not on a GET). Applying the check to GET is defense-in-depth.
  if (!origin) {
    // Absent Origin ⇒ not a browser fetch/XHR (those always send it). Allow:
    // same-origin GETs frequently omit Origin, and non-browser callers (curl,
    // MCP tools, the in-process dev-server tools) have no confused browser to
    // exploit. The Host check above still guards these against DNS rebinding.
    return { allow: true };
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Unparseable Origin header — fail closed rather than guess.
    return { allow: false, reason: "cross-origin request blocked" };
  }

  if (!allowedHosts.has(originHost.toLowerCase())) {
    return { allow: false, reason: "cross-origin request blocked" };
  }

  return { allow: true };
}

export function proxy(request: NextRequest) {
  const result = evaluateRequest({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    pathname: request.nextUrl.pathname,
  });

  if (!result.allow) {
    return NextResponse.json({ error: result.reason }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
