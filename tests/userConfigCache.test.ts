import { describe, it, expect } from "vitest";
import { extractSettingsKeys } from "@/lib/userConfigCache";

describe("extractSettingsKeys", () => {
  it("returns empty array for empty doc", () => {
    expect(extractSettingsKeys({})).toEqual([]);
  });

  it("excludes hooks, mcpServers, and enabledPlugins", () => {
    const doc = {
      hooks: { PostToolUse: [] },
      mcpServers: { "my-server": {} },
      enabledPlugins: { "review@official": true },
      statusLine: "minimal",
    };
    const result = extractSettingsKeys(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ keyPath: "statusLine", value: "minimal" });
  });

  it("preserves all non-excluded top-level keys", () => {
    const doc = {
      statusLine: "full",
      permissions: { allow: ["Bash(*)"] },
      env: { API_KEY: "" },
    };
    const result = extractSettingsKeys(doc);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.keyPath).sort()).toEqual(["env", "permissions", "statusLine"]);
  });

  it("preserves value shapes (objects, arrays, scalars)", () => {
    const doc = {
      statusLine: "minimal",
      permissions: { allow: ["Bash(*)"] },
      customList: [1, 2, 3],
      debugMode: false,
    };
    const result = extractSettingsKeys(doc);
    const byKey = Object.fromEntries(result.map((r) => [r.keyPath, r.value]));
    expect(byKey.statusLine).toBe("minimal");
    expect(byKey.permissions).toEqual({ allow: ["Bash(*)"] });
    expect(byKey.customList).toEqual([1, 2, 3]);
    expect(byKey.debugMode).toBe(false);
  });

  it("returns empty array when doc has only excluded keys", () => {
    const doc = {
      hooks: {},
      mcpServers: {},
      enabledPlugins: {},
    };
    expect(extractSettingsKeys(doc)).toEqual([]);
  });
});
