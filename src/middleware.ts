import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Origin/Host protection for the local API surface (finding S1).
//
// Project Minder is a local-only, no-auth dashboard — see the header comment
// on src/app/api/sql/route.ts for the same "no auth by design" posture on
// that endpoint. No-auth is fine for a tool only your own machine can reach,
// but that assumption only holds if nothing *else* can reach it either. Two
// distinct browser-based threats close that gap, and this middleware
// defends against both with two separate checks:
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
//      the same host allowlist. This applies to GET/HEAD too: a GET exemption
//      would assume reads are side-effect-free, but some GET routes mutate
//      (e.g. /api/tasks and /api/swarms start the dispatcher via
//      initDispatcher()), and this dashboard is same-origin-only, so a
//      cross-origin browser request is never legitimate regardless of method.
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

// Hosts/origins this dashboard is actually served on. Every entry carries the
// :4100 dev port on purpose. The port is what makes the Origin check
// trustworthy: 4100 is non-default, so a browser never elides it, and a legit
// same-origin request always presents `localhost:4100` (not bare `localhost`).
// Allowing a port-less `localhost` would let a page served from
// http://localhost/ (port 80 — a *different* origin) pass the Origin check and
// drive state-changing endpoints (CSRF); requiring the port closes that.
//
// This is a superset of ALLOWED_HOSTS/ALLOWED_ORIGINS in src/lib/mcp/server.ts
// (it adds the IPv6 loopback [::1]:4100); the shared invariant is that only the
// :4100 entries are trusted. If the dev port ever changes from 4100, update
// this set, the MCP server's lists, and docs/help/mcp-server.md together.
const ALLOWED_HOSTS = new Set([
  "localhost:4100",
  "127.0.0.1:4100",
  "[::1]:4100",
]);

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
 * Pure decision function extracted out of the Next.js middleware so it can
 * be unit-tested directly (no NextRequest/NextResponse construction needed).
 * See the file-header comment above for the two-layer rationale.
 */
export function evaluateRequest({
  // `method` is part of EvaluateInput (and still passed by callers/tests) but
  // the allowlist now applies to every method, so it isn't read here.
  host,
  origin,
  pathname,
}: EvaluateInput): EvaluateResult {
  // Only the API surface is guarded — everything else (pages, static
  // assets) is unaffected, and `config.matcher` below scopes the middleware
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
  if (!host || !ALLOWED_HOSTS.has(host.toLowerCase())) {
    return { allow: false, reason: "host not allowed" };
  }

  // Layer 2 — Origin allowlist, applied to ALL methods (including GET/HEAD).
  // A GET exemption would rest on "reads can't mutate state," but that's false
  // here: several GET routes have side effects — e.g. /api/tasks and
  // /api/swarms call initDispatcher(), starting the background task dispatcher
  // — so a cross-site scripted GET is a real CSRF vector. This dashboard is
  // same-origin-only, so a cross-origin browser fetch/XHR (which always carries
  // an Origin) is never legitimate regardless of method — block it.
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

  if (!ALLOWED_HOSTS.has(originHost.toLowerCase())) {
    return { allow: false, reason: "cross-origin request blocked" };
  }

  return { allow: true };
}

export function middleware(request: NextRequest) {
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
