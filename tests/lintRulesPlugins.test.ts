import { describe, it, expect } from "vitest";
import { runPluginRules } from "@/lib/lint/rules/plugins";
import type { PluginEntry } from "@/lib/types";

function makePlugin(
  name: string,
  opts: Partial<PluginEntry> = {},
): PluginEntry {
  return {
    name,
    marketplace: "official",
    enabled: true,
    blocked: false,
    ...opts,
  };
}

describe("plugin/blocked-but-enabled", () => {
  it("returns no findings for a normally enabled plugin", () => {
    const plugins = [makePlugin("hooks-plugin", { version: "1.0.0" })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/blocked-but-enabled");
    expect(findings).toHaveLength(0);
  });

  it("flags a plugin that is both enabled and blocked", () => {
    const plugins = [makePlugin("risky-plugin", { enabled: true, blocked: true })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/blocked-but-enabled");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P1");
    expect(findings[0].engine).toBe("vendored");
    expect(findings[0].title).toContain("risky-plugin");
  });

  it("does not flag a blocked-but-not-enabled plugin", () => {
    const plugins = [makePlugin("old-plugin", { enabled: false, blocked: true })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/blocked-but-enabled");
    expect(findings).toHaveLength(0);
  });
});

describe("plugin/unpinned-version", () => {
  it("returns no findings when version is pinned", () => {
    const plugins = [makePlugin("my-plugin", { version: "2.1.0" })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/unpinned-version");
    expect(findings).toHaveLength(0);
  });

  it("returns no findings when gitCommitSha is set (equivalent pin)", () => {
    const plugins = [makePlugin("my-plugin", { gitCommitSha: "abc123def456" })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/unpinned-version");
    expect(findings).toHaveLength(0);
  });

  it("flags an enabled plugin with no version or commit SHA", () => {
    const plugins = [makePlugin("unpinned-plugin")];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/unpinned-version");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("P2");
    expect(findings[0].title).toContain("unpinned-plugin");
  });

  it("does not flag a blocked plugin (it won't run regardless)", () => {
    const plugins = [makePlugin("blocked-plugin", { blocked: true, enabled: false })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/unpinned-version");
    expect(findings).toHaveLength(0);
  });

  it("does not flag a disabled plugin", () => {
    const plugins = [makePlugin("disabled-plugin", { enabled: false })];
    const findings = runPluginRules(plugins).filter((f) => f.code === "plugin/unpinned-version");
    expect(findings).toHaveLength(0);
  });
});
