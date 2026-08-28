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

  // #491 — `enabledAdapters` enables ADDITIONAL harnesses; it is not a source
  // filter. Claude was always read on both backends regardless of the setting,
  // so the setting could express a state the app did not honour. It no longer
  // can. See `adapters/substrate.ts` for why the filter was not built instead.
  describe("the claude substrate (#491)", () => {
    it("reads claude even when the config omits it", async () => {
      const { getEnabledAdapters } = await import("@/lib/adapters");
      const adapters = getEnabledAdapters({ enabledAdapters: ["codex"] } as any);
      expect(adapters.map((a) => a.id)).toEqual(["claude", "codex"]);
    });

    it("reads claude when the config enables nothing at all", async () => {
      const { getEnabledAdapters } = await import("@/lib/adapters");
      expect(
        getEnabledAdapters({ enabledAdapters: [] } as any).map((a) => a.id)
      ).toEqual(["claude"]);
    });

    it("does not duplicate or reorder a list that already has it", async () => {
      const { normalizeEnabledAdapters } = await import("@/lib/adapters");
      expect(normalizeEnabledAdapters(["codex", "claude"])).toEqual([
        "codex",
        "claude",
      ]);
      expect(normalizeEnabledAdapters(["claude", "gemini"])).toEqual([
        "claude",
        "gemini",
      ]);
    });

    it("prepends rather than appends, so claude leads a normalised list", async () => {
      const { normalizeEnabledAdapters } = await import("@/lib/adapters");
      expect(normalizeEnabledAdapters(["gemini", "codex"])).toEqual([
        "claude",
        "gemini",
        "codex",
      ]);
    });

    it("does not mutate the caller's array", async () => {
      const { normalizeEnabledAdapters } = await import("@/lib/adapters");
      const input = ["codex"];
      normalizeEnabledAdapters(input);
      expect(input).toEqual(["codex"]);
    });

    it("is importable from a leaf that pulls in no adapter modules", async () => {
      // `AdaptersSection` is a "use client" component. Importing the registry
      // there would drag `fs` into the browser bundle — the failure class that
      // shipped CI red on PR #324, which typecheck and this suite are both
      // structurally unable to see. The leaf is what makes that import safe,
      // so this asserts the leaf resolves on its own.
      const leaf = await import("@/lib/adapters/substrate");
      expect(leaf.SUBSTRATE_ADAPTER_ID).toBe("claude");
      expect(typeof leaf.normalizeEnabledAdapters).toBe("function");
    });

    it("re-exports the SAME function from the registry barrel", async () => {
      const leaf = await import("@/lib/adapters/substrate");
      const barrel = await import("@/lib/adapters");
      expect(barrel.normalizeEnabledAdapters).toBe(leaf.normalizeEnabledAdapters);
      expect(barrel.SUBSTRATE_ADAPTER_ID).toBe(leaf.SUBSTRATE_ADAPTER_ID);
    });
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
