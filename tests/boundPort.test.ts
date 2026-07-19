import { describe, it, expect } from "vitest";
import {
  DEFAULT_PORT,
  resolveBoundPort,
  buildAllowedHosts,
  buildAllowedOrigins,
} from "@/lib/boundPort";

describe("resolveBoundPort", () => {
  it("defaults to 4100 when PORT is unset", () => {
    expect(resolveBoundPort({})).toBe(DEFAULT_PORT);
  });

  it("honors a valid PORT — the tray passes MINDER_TRAY_PORT through as PORT", () => {
    expect(resolveBoundPort({ PORT: "4199" })).toBe(4199);
  });

  it.each([
    ["empty", ""],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-1"],
    ["above the 16-bit range", "65536"],
  ])("falls back to the default for a %s PORT", (_label, port) => {
    expect(resolveBoundPort({ PORT: port })).toBe(DEFAULT_PORT);
  });

  it("accepts the boundary ports 1 and 65535", () => {
    expect(resolveBoundPort({ PORT: "1" })).toBe(1);
    expect(resolveBoundPort({ PORT: "65535" })).toBe(65535);
  });
});

describe("buildAllowedHosts", () => {
  it("covers the full loopback trio on the bound port", () => {
    expect(buildAllowedHosts(4199)).toEqual(
      new Set(["localhost:4199", "127.0.0.1:4199", "[::1]:4199"])
    );
  });

  // The security property documented in src/lib/boundPort.ts: trusting the
  // canonical 4100 on a server bound elsewhere would let any other local
  // process serving a page on 4100 drive these APIs cross-origin (issue #283).
  it("does NOT trust the canonical 4100 when bound to another port", () => {
    const hosts = buildAllowedHosts(4199);
    expect(hosts.has("localhost:4100")).toBe(false);
    expect(hosts.has("127.0.0.1:4100")).toBe(false);
  });
});

describe("buildAllowedOrigins", () => {
  it("mirrors the host trio as absolute http origins", () => {
    expect(buildAllowedOrigins(4199)).toEqual([
      "http://localhost:4199",
      "http://127.0.0.1:4199",
      "http://[::1]:4199",
    ]);
  });

  // Regression guard for the drift this module was extracted to prevent: the
  // MCP transport allowlist was pinned to a literal 4100 while the dashboard
  // proxy honored PORT, so a custom port 403'd every MCP request.
  it("stays in lockstep with buildAllowedHosts for any port", () => {
    for (const port of [1, 3000, 4100, 4199, 65535]) {
      const fromOrigins = buildAllowedOrigins(port).map((o) =>
        o.replace(/^http:\/\//, "")
      );
      expect(new Set(fromOrigins)).toEqual(buildAllowedHosts(port));
    }
  });
});
