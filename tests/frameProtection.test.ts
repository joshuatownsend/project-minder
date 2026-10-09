import { describe, it, expect } from "vitest";
import nextConfig from "../next.config";

// #642 — another site must not be able to frame the dashboard: the framed page's own same-origin
// fetches would otherwise pass the Sec-Fetch-Site rule in src/proxy.ts.

describe("anti-framing headers (#642)", () => {
  it("every route is sent with X-Frame-Options DENY and frame-ancestors 'none'", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    const h = Object.fromEntries(all!.headers.map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
  });
});
