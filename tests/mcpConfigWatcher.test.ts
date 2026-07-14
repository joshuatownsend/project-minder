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

  it("collapses a missing or non-object mcpServers to a stable sentinel", () => {
    expect(mcpServersSignature("{}")).toBe("∅");
    expect(mcpServersSignature('{"mcpServers": null}')).toBe("∅");
    expect(mcpServersSignature("not json")).toBe("∅");
    expect(mcpServersSignature('{"mcpServers": {}}')).not.toBe("∅"); // empty-but-present object differs
  });
});
