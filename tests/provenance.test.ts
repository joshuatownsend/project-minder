import { describe, it, expect } from "vitest";
import { resolveProvenance } from "@/lib/indexer/provenance";
import type { ProvenanceContext, InstalledPlugin, LockfileEntry } from "@/lib/indexer/types";

const EMPTY_CTX: ProvenanceContext = {
  installedPlugins: [],
  lockfile: new Map(),
  marketplaceRepo: new Map(),
};

function makePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginName: "nextjs",
    installPath: "/fake/plugins/nextjs",
    marketplace: "anthropics/claude-plugins-official",
    version: "1.2.0",
    gitCommitSha: "abc1234",
    installedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeLockEntry(overrides: Partial<LockfileEntry> = {}): LockfileEntry {
  return {
    source: "clerk/skills",
    sourceType: "github",
    sourceUrl: "https://github.com/clerk/skills.git",
    skillPath: "skills/clerk/SKILL.md",
    skillFolderHash: "def456",
    installedAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveProvenance", () => {
  describe("project-local", () => {
    it("returns project-local when source is project", () => {
      const result = resolveProvenance({
        source: "project",
        slug: "my-skill",
        projectSlug: "my-project",
        ctx: EMPTY_CTX,
      });
      expect(result.kind).toBe("project-local");
      if (result.kind === "project-local") {
        expect(result.projectSlug).toBe("my-project");
      }
    });
  });

  describe("marketplace-plugin", () => {
    it("returns marketplace-plugin when plugin is found in context", () => {
      const plugin = makePlugin();
      const ctx: ProvenanceContext = {
        ...EMPTY_CTX,
        installedPlugins: [plugin],
        marketplaceRepo: new Map([
          ["anthropics/claude-plugins-official", "anthropics/claude-plugins-official"],
        ]),
      };

      const result = resolveProvenance({
        source: "plugin",
        slug: "nextjs",
        pluginName: "nextjs",
        ctx,
      });

      expect(result.kind).toBe("marketplace-plugin");
      if (result.kind === "marketplace-plugin") {
        expect(result.pluginName).toBe("nextjs");
        expect(result.marketplace).toBe("anthropics/claude-plugins-official");
        expect(result.marketplaceRepo).toBe("anthropics/claude-plugins-official");
        expect(result.gitCommitSha).toBe("abc1234");
        expect(result.pluginVersion).toBe("1.2.0");
      }
    });

    it("omits pluginVersion when version is 'unknown'", () => {
      const plugin = makePlugin({ version: "unknown" });
      const ctx: ProvenanceContext = { ...EMPTY_CTX, installedPlugins: [plugin] };

      const result = resolveProvenance({
        source: "plugin",
        slug: "nextjs",
        pluginName: "nextjs",
        ctx,
      });

      expect(result.kind).toBe("marketplace-plugin");
      if (result.kind === "marketplace-plugin") {
        expect(result.pluginVersion).toBeUndefined();
      }
    });

    it("falls back to user-local when pluginName is not in ctx.installedPlugins", () => {
      const result = resolveProvenance({
        source: "plugin",
        slug: "unknown-plugin",
        pluginName: "unknown-plugin",
        ctx: EMPTY_CTX,
      });
      expect(result.kind).toBe("user-local");
    });
  });

  describe("lockfile", () => {
    it("returns lockfile when slug matches a lockfile entry", () => {
      const lockEntry = makeLockEntry();
      const ctx: ProvenanceContext = {
        ...EMPTY_CTX,
        lockfile: new Map([["clerk", lockEntry]]),
      };

      const result = resolveProvenance({ source: "user", slug: "clerk", ctx });

      expect(result.kind).toBe("lockfile");
      if (result.kind === "lockfile") {
        expect(result.sourceUrl).toBe("https://github.com/clerk/skills.git");
        expect(result.skillFolderHash).toBe("def456");
        expect(result.symlinkTarget).toBeUndefined();
      }
    });

    it("includes symlinkTarget when entry is a symlink", () => {
      const lockEntry = makeLockEntry();
      const ctx: ProvenanceContext = {
        ...EMPTY_CTX,
        lockfile: new Map([["clerk", lockEntry]]),
      };

      const result = resolveProvenance({
        source: "user",
        slug: "clerk",
        isSymlink: true,
        realPath: "/home/user/.agents/skills/clerk/SKILL.md",
        ctx,
      });

      expect(result.kind).toBe("lockfile");
      if (result.kind === "lockfile") {
        expect(result.symlinkTarget).toBe("/home/user/.agents/skills/clerk/SKILL.md");
      }
    });

    it("resolves symlink by parent dir name when slug does not match directly", () => {
      const lockEntry = makeLockEntry();
      const ctx: ProvenanceContext = {
        ...EMPTY_CTX,
        // lockfile key is "clerk" but the symlink's realPath parent dirname is also "clerk"
        lockfile: new Map([["clerk", lockEntry]]),
      };

      const result = resolveProvenance({
        source: "user",
        slug: "clerk-alias",      // slug doesn't match
        isSymlink: true,
        realPath: "/home/user/.agents/skills/clerk/SKILL.md",
        ctx,
      });

      expect(result.kind).toBe("lockfile");
    });
  });

  describe("user-local fallback", () => {
    it("returns user-local when source is user and no lockfile entry exists", () => {
      const result = resolveProvenance({
        source: "user",
        slug: "my-custom-skill",
        ctx: EMPTY_CTX,
      });
      expect(result.kind).toBe("user-local");
    });

    it("returns user-local for plugin source without pluginName", () => {
      const result = resolveProvenance({
        source: "plugin",
        slug: "orphan",
        ctx: EMPTY_CTX,
      });
      expect(result.kind).toBe("user-local");
    });
  });
});
