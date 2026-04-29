import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let tmp: string;
let target: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyPlugin-test-"));
  target = path.join(tmp, "target");
  await fs.mkdir(target, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

async function readSettings(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

describe("applyPlugin — happy path", () => {
  it("creates settings.json when missing and writes enable flag", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "review", marketplace: "official", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "review@official",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
    const doc = (await readSettings(path.join(target, ".claude", "settings.json"))) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(doc.enabledPlugins).toEqual({ "review@official": true });
  });

  it("preserves unrelated keys", async () => {
    await fs.mkdir(path.join(target, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["x"] } }),
      "utf-8"
    );
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "skip",
    });
    const doc = (await readSettings(path.join(target, ".claude", "settings.json"))) as {
      permissions: unknown;
      enabledPlugins: Record<string, boolean>;
    };
    expect(doc.permissions).toEqual({ allow: ["x"] });
    expect(doc.enabledPlugins["p@m"]).toBe(true);
  });
});

describe("applyPlugin — requires-install warning", () => {
  it("surfaces a warning when the plugin isn't in the user-scope registry", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "missing@example",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => w.includes("not installed"))).toBe(true);
    expect(result.warnings?.some((w) => w.includes("/plugin install missing@example"))).toBe(true);
    // The enable flag still lands so it activates once the plugin is installed.
    const doc = (await readSettings(path.join(target, ".claude", "settings.json"))) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(doc.enabledPlugins["missing@example"]).toBe(true);
  });
});

describe("applyPlugin — conflict policies", () => {
  it("skips when already enabled and conflict=skip", async () => {
    await fs.mkdir(path.join(target, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "p@m": true } }),
      "utf-8"
    );
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.status).toBe("skipped");
    expect(result.changedFiles).toEqual([]);
  });

  it.each(["merge" as const, "overwrite" as const])(
    "is idempotent when already enabled — conflict=%s returns skipped + no changedFiles + no mtime bump",
    async (policy) => {
      // Regression for PR #28 review: previously, only conflict=skip
      // short-circuited; merge/overwrite would re-write the file with
      // identical content, bumping mtime and reporting changedFiles.
      await fs.mkdir(path.join(target, ".claude"), { recursive: true });
      const settingsPath = path.join(target, ".claude", "settings.json");
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ enabledPlugins: { "p@m": true } }),
        "utf-8"
      );
      const beforeMtime = (await fs.stat(settingsPath)).mtimeMs;

      vi.doMock("@/lib/indexer/walkPlugins", () => ({
        loadInstalledPlugins: async () => [
          { pluginName: "p", marketplace: "m", installPath: "/x" },
        ],
      }));
      const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
      // Wait a tick so mtime granularity (ms-level on most FSes) doesn't
      // accidentally hide a write.
      await new Promise((r) => setTimeout(r, 10));
      const result = await fn({
        pluginKey: "p@m",
        targetProjectPath: target,
        conflict: policy,
      });

      expect(result.status).toBe("skipped");
      expect(result.changedFiles).toEqual([]);
      const afterMtime = (await fs.stat(settingsPath)).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    }
  );

  it("dryRun preview for an already-enabled plugin reports [no change] + empty changedFiles", async () => {
    await fs.mkdir(path.join(target, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "p@m": true } }),
      "utf-8"
    );
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "merge",
      dryRun: true,
    });
    expect(result.status).toBe("would-apply");
    expect(result.changedFiles).toEqual([]);
    expect(result.diffPreview).toContain("[no change");
  });

  it("rejects rename for plugin units", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "rename",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RENAME_NOT_SUPPORTED_FOR_PLUGIN");
  });

  it("flips false → true on overwrite", async () => {
    await fs.mkdir(path.join(target, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(target, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "p@m": false } }),
      "utf-8"
    );
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "overwrite",
    });
    expect(result.ok).toBe(true);
    const doc = (await readSettings(path.join(target, ".claude", "settings.json"))) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(doc.enabledPlugins["p@m"]).toBe(true);
  });
});

describe("applyPlugin — malformed target", () => {
  it("refuses to overwrite a malformed settings.json", async () => {
    await fs.mkdir(path.join(target, ".claude"), { recursive: true });
    await fs.writeFile(path.join(target, ".claude", "settings.json"), "{ not json", "utf-8");
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "skip",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MALFORMED_TARGET");
  });
});

describe("applyPlugin — dryRun", () => {
  it("dryRun returns would-apply without touching disk", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "p", marketplace: "m", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "p@m",
      targetProjectPath: target,
      conflict: "skip",
      dryRun: true,
    });
    expect(result.status).toBe("would-apply");
    await expect(fs.access(path.join(target, ".claude", "settings.json"))).rejects.toThrow();
  });
});

describe("applyPlugin — user-scope source (V5)", () => {
  it("surfaces a user→project promotion warning when sourceScope is 'user'", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "review", marketplace: "official", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "review@official",
      targetProjectPath: target,
      conflict: "skip",
      sourceScope: "user",
    });
    expect(result.ok).toBe(true);
    // The user→project warning should mention the broader-scope rationale,
    // separate from the existing "not installed" warning.
    expect(result.warnings?.some((w) => /user-scope plugin enable/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /anyone using this repo/.test(w))).toBe(true);
  });

  it("does not surface a promotion warning when sourceScope is 'project'", async () => {
    vi.doMock("@/lib/indexer/walkPlugins", () => ({
      loadInstalledPlugins: async () => [
        { pluginName: "review", marketplace: "official", installPath: "/x" },
      ],
    }));
    const { applyPlugin: fn } = await import("@/lib/template/applyPlugin");
    const result = await fn({
      pluginKey: "review@official",
      targetProjectPath: target,
      conflict: "skip",
      sourceScope: "project",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /user-scope plugin enable/.test(w))).toBe(false);
  });
});
