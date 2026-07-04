/**
 * Unit tests for the pure decision function behind src/middleware.ts (S1).
 *
 * The middleware default export just adapts a NextRequest into the shape
 * `evaluateRequest` needs and turns the result into a NextResponse — all the
 * actual host/origin allowlist logic lives in `evaluateRequest`, so it's
 * tested directly rather than through a constructed NextRequest/middleware
 * invocation.
 */

import { describe, it, expect } from "vitest";
import { evaluateRequest } from "@/middleware";

const ALLOWED_HOST = "localhost:4100";
const ALLOWED_HOST_IP = "127.0.0.1:4100";
const ALLOWED_ORIGIN = "http://localhost:4100";
const DISALLOWED_HOST = "evil.example.com:4100";
const DISALLOWED_ORIGIN = "http://evil.example.com";

describe("evaluateRequest", () => {
  it("allows an allowed host with no Origin header (non-browser client, e.g. curl)", () => {
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST,
      origin: null,
      pathname: "/api/dev-server/my-app",
    });
    expect(result.allow).toBe(true);
  });

  it("allows an allowed host with a same-origin Origin header on a state-changing request", () => {
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST,
      origin: ALLOWED_ORIGIN,
      pathname: "/api/dev-server/my-app",
    });
    expect(result.allow).toBe(true);
  });

  it("blocks an allowed host with a cross-origin Origin header on POST (CSRF)", () => {
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/api/config",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("cross-origin request blocked");
  });

  it("blocks a disallowed Host on GET (DNS rebinding — reads are still guarded)", () => {
    const result = evaluateRequest({
      method: "GET",
      host: DISALLOWED_HOST,
      origin: null,
      pathname: "/api/sql",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("host not allowed");
  });

  it("blocks a missing Host header", () => {
    const result = evaluateRequest({
      method: "GET",
      host: null,
      origin: null,
      pathname: "/api/sql",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("host not allowed");
  });

  it("skips /api/mcp entirely, even with a disallowed host and cross-origin Origin", () => {
    const result = evaluateRequest({
      method: "POST",
      host: DISALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/api/mcp",
    });
    expect(result.allow).toBe(true);
  });

  it("allows a GET with a cross-origin Origin header (reads aren't a CSRF vector, but Host is still checked)", () => {
    const result = evaluateRequest({
      method: "GET",
      host: ALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/api/sql",
    });
    expect(result.allow).toBe(true);
  });

  it("blocks a GET with a cross-origin Origin AND a disallowed host (host check dominates)", () => {
    const result = evaluateRequest({
      method: "GET",
      host: DISALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/api/sql",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("host not allowed");
  });

  it("treats HEAD like GET — allowed host, cross-origin Origin still passes", () => {
    const result = evaluateRequest({
      method: "HEAD",
      host: ALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/api/projects",
    });
    expect(result.allow).toBe(true);
  });

  it("blocks HEAD on a disallowed host", () => {
    const result = evaluateRequest({
      method: "HEAD",
      host: DISALLOWED_HOST,
      origin: null,
      pathname: "/api/projects",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("host not allowed");
  });

  it("allows the 127.0.0.1:4100 host/origin variant", () => {
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST_IP,
      origin: "http://127.0.0.1:4100",
      pathname: "/api/config",
    });
    expect(result.allow).toBe(true);
  });

  it("allows IPv6 loopback [::1]:4100", () => {
    const result = evaluateRequest({
      method: "POST",
      host: "[::1]:4100",
      origin: "http://[::1]:4100",
      pathname: "/api/config",
    });
    expect(result.allow).toBe(true);
  });

  it("blocks a port-less same-host Origin on POST (page served from http://localhost/ on port 80 is a different origin)", () => {
    // Regression: the allowlist must require :4100 on the Origin. A page at
    // http://localhost/ (default port 80) can POST to :4100 with a valid Host
    // header; without the port requirement its Origin (`localhost`) would have
    // matched a port-less allowlist entry and passed the CSRF check.
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST,
      origin: "http://localhost",
      pathname: "/api/config",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("cross-origin request blocked");
  });

  it("is case-insensitive for the Host header", () => {
    const result = evaluateRequest({
      method: "GET",
      host: "LOCALHOST:4100",
      origin: null,
      pathname: "/api/sql",
    });
    expect(result.allow).toBe(true);
  });

  it("bypasses all checks for non-/api paths", () => {
    const result = evaluateRequest({
      method: "POST",
      host: DISALLOWED_HOST,
      origin: DISALLOWED_ORIGIN,
      pathname: "/dashboard",
    });
    expect(result.allow).toBe(true);
  });

  it("blocks an unparseable Origin header on a state-changing request", () => {
    const result = evaluateRequest({
      method: "POST",
      host: ALLOWED_HOST,
      origin: "not-a-valid-url",
      pathname: "/api/config",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe("cross-origin request blocked");
  });
});
