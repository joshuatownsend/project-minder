import { describe, expect, it } from "vitest";
import {
  formatFrontmatterValue,
  frontmatterTableEntries,
  versionRows,
} from "@/lib/catalogDetail";
import type { Provenance } from "@/lib/indexer/types";

describe("formatFrontmatterValue", () => {
  it("passes strings through unchanged", () => {
    expect(formatFrontmatterValue("hello")).toBe("hello");
    expect(formatFrontmatterValue("")).toBe("");
  });

  it("stringifies numbers and booleans", () => {
    expect(formatFrontmatterValue(42)).toBe("42");
    expect(formatFrontmatterValue(true)).toBe("true");
    expect(formatFrontmatterValue(false)).toBe("false");
  });

  it("joins array values with comma-space", () => {
    expect(formatFrontmatterValue(["a", "b", "c"])).toBe("a, b, c");
    expect(formatFrontmatterValue([])).toBe("");
  });

  it("recurses into nested arrays before stringifying", () => {
    expect(formatFrontmatterValue([1, "two", true])).toBe("1, two, true");
  });

  it("JSON.stringifies plain objects", () => {
    expect(formatFrontmatterValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("frontmatterTableEntries", () => {
  it("drops name and description (rendered separately in the header)", () => {
    const entries = frontmatterTableEntries({
      name: "foo",
      description: "bar",
      category: "tools",
    });
    expect(entries).toEqual([["category", "tools"]]);
  });

  it("drops empty strings, null, and undefined values", () => {
    const entries = frontmatterTableEntries({
      keep: "v",
      emptyStr: "",
      nullish: null as unknown,
      missing: undefined as unknown,
      zero: 0, // 0 is meaningful — should be kept
      falsy: false, // false is meaningful — should be kept
    });
    const keys = entries.map(([k]) => k);
    expect(keys).toEqual(["keep", "zero", "falsy"]);
  });

  it("preserves declared insertion order", () => {
    const entries = frontmatterTableEntries({
      z: "1",
      a: "2",
      m: "3",
    });
    expect(entries.map(([k]) => k)).toEqual(["z", "a", "m"]);
  });
});

describe("versionRows", () => {
  it("returns [] for user-local provenance (not version-tracked)", () => {
    const p: Provenance = { kind: "user-local" };
    expect(versionRows(p)).toEqual([]);
  });

  it("returns [] for project-local provenance", () => {
    const p: Provenance = { kind: "project-local", projectSlug: "my-app" };
    expect(versionRows(p)).toEqual([]);
  });

  it("returns [] for lockfile provenance (not marketplace-plugin)", () => {
    const p: Provenance = {
      kind: "lockfile",
      source: "clerk/skills",
      sourceType: "github",
      sourceUrl: "https://github.com/clerk/skills.git",
      skillPath: "skills/clerk/SKILL.md",
      skillFolderHash: "abc123",
      installedAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
    };
    expect(versionRows(p)).toEqual([]);
  });

  it("returns ordered rows for a fully-populated marketplace-plugin", () => {
    const p: Provenance = {
      kind: "marketplace-plugin",
      pluginName: "my-plugin",
      marketplace: "anthropics",
      marketplaceRepo: "anthropics/claude-plugins-official",
      pluginVersion: "1.2.3",
      gitCommitSha: "deadbeef",
      installedAt: "2026-05-01T00:00:00Z",
      lastUpdated: "2026-05-08T00:00:00Z",
    };
    const rows = versionRows(p);
    expect(rows.map((r) => r.label)).toEqual([
      "Plugin",
      "Version",
      "Marketplace",
      "Repo",
      "Commit",
      "Installed",
      "Last updated",
    ]);
    expect(rows[0].value).toBe("my-plugin");
    expect(rows[1].value).toBe("1.2.3");
  });

  it("omits rows whose value is missing or empty", () => {
    const p: Provenance = {
      kind: "marketplace-plugin",
      pluginName: "my-plugin",
      marketplace: "anthropics",
      // no pluginVersion, no commit, etc.
    };
    const labels = versionRows(p).map((r) => r.label);
    expect(labels).toEqual(["Plugin", "Marketplace"]);
  });
});
