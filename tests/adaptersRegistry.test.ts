import { describe, it, expect, vi } from "vitest";

// Registry is a module singleton — import directly to test its public API.
// We cannot easily reset the registry between tests, so we test against the
// real registered state (claude registered at import time).

describe("adapter registry", () => {
  it("listAdapters returns claude by default", async () => {
    const { listAdapters } = await import("@/lib/adapters");
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(1);
    expect(adapters.map((a) => a.id)).toContain("claude");
  });

  it("getAdapter returns the claude adapter", async () => {
    const { getAdapter } = await import("@/lib/adapters");
    const adapter = getAdapter("claude");
    expect(adapter).toBeDefined();
    expect(adapter!.id).toBe("claude");
    expect(adapter!.displayName).toBe("Claude Code");
    expect(typeof adapter!.discover).toBe("function");
    expect(typeof adapter!.parseFile).toBe("function");
    expect(typeof adapter!.parseFileWithMeta).toBe("function");
  });

  it("getAdapter returns undefined for unknown id", async () => {
    const { getAdapter } = await import("@/lib/adapters");
    expect(getAdapter("nonexistent")).toBeUndefined();
  });

  it("getEnabledAdapters honors enabledAdapters config", async () => {
    const { getEnabledAdapters } = await import("@/lib/adapters");
    const adapters = getEnabledAdapters({ enabledAdapters: ["claude"] } as any);
    expect(adapters.map((a) => a.id)).toEqual(["claude"]);
  });

  it("getEnabledAdapters silently drops unknown adapter ids (with warn)", async () => {
    const { getEnabledAdapters } = await import("@/lib/adapters");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapters = getEnabledAdapters({ enabledAdapters: ["claude", "unknown-xyz"] } as any);
    expect(adapters.map((a) => a.id)).toEqual(["claude"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-xyz"));
    warnSpy.mockRestore();
  });

  it("discoverAllSessions returns SessionFile[] with source=claude from the claude adapter", async () => {
    const { discoverAllSessions } = await import("@/lib/adapters");
    // discover() reads ~home/.claude/projects which may or may not exist in CI.
    // The important check is that whatever is returned has source='claude'.
    const files = await discoverAllSessions({ enabledAdapters: ["claude"] } as any);
    for (const f of files) {
      expect(f.source).toBe("claude");
      expect(typeof f.filePath).toBe("string");
      expect(typeof f.projectDirName).toBe("string");
    }
  });
});
