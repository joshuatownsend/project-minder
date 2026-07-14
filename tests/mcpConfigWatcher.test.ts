import { describe, it, expect } from "vitest";
import { mcpServersSignature } from "@/lib/mcpConfigWatcher";

describe("mcpServersSignature", () => {
  const withServers = (servers: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...extra, mcpServers: servers });

  it("is stable for the same mcpServers block", () => {
    const a = withServers({ foo: { command: "node" } });
    const b = withServers({ foo: { command: "node" } });
    expect(mcpServersSignature(a)).toBe(mcpServersSignature(b));
  });

  it("ignores unrelated runtime-state fields (no thrash on Claude Code writes)", () => {
    // ~/.claude.json is rewritten constantly with runtime state; those writes
    // must NOT register as an MCP change.
    const before = withServers({ foo: { command: "node" } }, { numStartups: 41, oauthAccount: {} });
    const after = withServers({ foo: { command: "node" } }, { numStartups: 42, lastActive: "later" });
    expect(mcpServersSignature(before)).toBe(mcpServersSignature(after));
  });

  it("is stable regardless of key order", () => {
    const a = withServers({ foo: { command: "node" }, bar: { url: "https://x" } });
    const b = withServers({ bar: { url: "https://x" }, foo: { command: "node" } });
    expect(mcpServersSignature(a)).toBe(mcpServersSignature(b));
  });

  it("changes when a server is added", () => {
    const before = withServers({ foo: { command: "node" } });
    const after = withServers({ foo: { command: "node" }, bar: { command: "deno" } });
    expect(mcpServersSignature(before)).not.toBe(mcpServersSignature(after));
  });

  it("changes when a server is removed", () => {
    const before = withServers({ foo: { command: "node" }, bar: { command: "deno" } });
    const after = withServers({ foo: { command: "node" } });
    expect(mcpServersSignature(before)).not.toBe(mcpServersSignature(after));
  });

  it("changes when a server's definition changes", () => {
    const before = withServers({ foo: { command: "node" } });
    const after = withServers({ foo: { command: "deno" } });
    expect(mcpServersSignature(before)).not.toBe(mcpServersSignature(after));
  });

  it("excludes env VALUES — a rotated secret does not change the signature", () => {
    // env values may be credentials; they must never sit in the watcher's
    // lastSig, and rotating one must not thrash the cache.
    const before = withServers({ foo: { command: "node", env: { API_KEY: "secret-v1" } } });
    const after = withServers({ foo: { command: "node", env: { API_KEY: "secret-v2" } } });
    const sig = mcpServersSignature(before);
    expect(sig).toBe(mcpServersSignature(after));
    expect(sig).not.toContain("secret-v1"); // value never retained
  });

  it("changes when an env KEY is added (a config change, not a secret rotation)", () => {
    const before = withServers({ foo: { command: "node", env: { A: "1" } } });
    const after = withServers({ foo: { command: "node", env: { A: "1", B: "2" } } });
    expect(mcpServersSignature(before)).not.toBe(mcpServersSignature(after));
  });

  it("is stable across key reorder inside a server definition", () => {
    const a = withServers({ foo: { command: "node", url: "https://x", env: { A: "1", B: "2" } } });
    const b = withServers({ foo: { env: { B: "2", A: "1" }, url: "https://x", command: "node" } });
    expect(mcpServersSignature(a)).toBe(mcpServersSignature(b));
  });

  it("collapses a missing or non-object mcpServers to a stable sentinel", () => {
    expect(mcpServersSignature("{}")).toBe("∅");
    expect(mcpServersSignature('{"mcpServers": null}')).toBe("∅");
    expect(mcpServersSignature("not json")).toBe("∅");
    expect(mcpServersSignature('{"mcpServers": {}}')).not.toBe("∅"); // empty-but-present object differs
  });
});
