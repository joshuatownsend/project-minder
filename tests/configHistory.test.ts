import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// configHistory snapshots files into ~/.minder/config-history/<id>/ before
// the apply layer mutates them. Tests redirect $HOME via os.homedir mock so
// the manifest + snapshot bytes land in a tmpdir per test, not the real
// user's home.

let tmpHome: string;

async function reloadModule() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  return await import("@/lib/configHistory");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-config-history-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("recordPreWrite", () => {
  it("returns null and does not throw when target file exists but read fails (EACCES)", async () => {
    const { recordPreWrite } = await reloadModule();
    // Pass a directory as the target — fs.readFile on a dir throws EISDIR.
    // recordPreWrite must swallow it (apply must not be blocked by snapshot
    // failure) and return null.
    const id = await recordPreWrite(tmpHome);
    expect(id).toBeNull();
  });

  it("snapshots an existing file and returns a stable BackupId", async () => {
    const { recordPreWrite } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"a": 1}', "utf-8");

    const id = await recordPreWrite(target, { label: "test-apply", projectSlug: "demo" });
    expect(id).not.toBeNull();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}$/);

    const snapshotDir = path.join(tmpHome, ".minder", "config-history", id!);
    const snapshotFile = path.join(snapshotDir, "settings.json");
    const stored = await fs.readFile(snapshotFile, "utf-8");
    expect(Buffer.from(stored, "base64").toString("utf-8")).toBe('{"a": 1}');
  });

  it("records wasMissing=true when target does not exist", async () => {
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "absent.json");

    const id = await recordPreWrite(target);
    expect(id).not.toBeNull();

    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0].wasMissing).toBe(true);
    expect(entries[0].contentSha).toBe("");
    expect(entries[0].snapshotPath).toBeUndefined();
  });

  it("appends one manifest entry per call (no dedup-on-write in Wave 1.2)", async () => {
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x": 1}', "utf-8");

    await recordPreWrite(target);
    await recordPreWrite(target);
    await recordPreWrite(target);

    const entries = await list();
    expect(entries).toHaveLength(3);
  });
});

describe("list", () => {
  it("returns empty array when manifest does not exist", async () => {
    const { list } = await reloadModule();
    const entries = await list();
    expect(entries).toEqual([]);
  });

  it("filters by projectSlug", async () => {
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");

    await recordPreWrite(target, { projectSlug: "alpha" });
    await recordPreWrite(target, { projectSlug: "beta" });
    await recordPreWrite(target); // no slug

    const all = await list();
    expect(all).toHaveLength(3);

    const alphaOnly = await list({ projectSlug: "alpha" });
    expect(alphaOnly).toHaveLength(1);
    expect(alphaOnly[0].projectSlug).toBe("alpha");
  });

  it("returns newest entry first", async () => {
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "first", "utf-8");
    const id1 = await recordPreWrite(target);
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(target, "second", "utf-8");
    const id2 = await recordPreWrite(target);

    const entries = await list();
    expect(entries[0].id).toBe(id2);
    expect(entries[1].id).toBe(id1);
  });

  it("skips malformed manifest lines without throwing", async () => {
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");
    await recordPreWrite(target);

    const manifestPath = path.join(tmpHome, ".minder", "config-history", "manifest.jsonl");
    const original = await fs.readFile(manifestPath, "utf-8");
    await fs.writeFile(manifestPath, original + "this is not json\n", "utf-8");

    const entries = await list();
    expect(entries).toHaveLength(1); // malformed line dropped, valid kept
  });
});

describe("restore", () => {
  it("writes the snapshot bytes back to the original target", async () => {
    const { recordPreWrite, restore } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"original": true}', "utf-8");

    const id = await recordPreWrite(target);
    await fs.writeFile(target, '{"mutated": true}', "utf-8");

    await restore(id!);
    const restored = await fs.readFile(target, "utf-8");
    expect(restored).toBe('{"original": true}');
  });

  it("deletes the target when the snapshot was wasMissing=true", async () => {
    const { recordPreWrite, restore } = await reloadModule();
    const target = path.join(tmpHome, "absent.json");

    const id = await recordPreWrite(target);
    await fs.writeFile(target, "later created", "utf-8");

    await restore(id!);
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots the current state before overwriting (restore is undoable)", async () => {
    const { recordPreWrite, restore, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, "v1", "utf-8");

    const id1 = await recordPreWrite(target);
    await fs.writeFile(target, "v2", "utf-8");

    await restore(id1!);

    // The pre-restore state ("v2") should now be in history too.
    const entries = await list();
    const labels = entries.map((e) => e.label);
    expect(labels.some((l) => l && l.startsWith("restore→"))).toBe(true);
    // Target is back to v1.
    expect(await fs.readFile(target, "utf-8")).toBe("v1");
  });

  it("throws on unknown BackupId", async () => {
    const { restore } = await reloadModule();
    await expect(restore("nonexistent-id")).rejects.toThrow(/No backup with id/);
  });
});

describe("prune", () => {
  it("keeps every entry within 24h", async () => {
    const { recordPreWrite, prune, list } = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");

    // 5 snapshots, all in the last few ms.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await recordPreWrite(target);
    }

    const before = await list();
    expect(before).toHaveLength(5);

    const result = await prune();
    expect(result.kept).toBe(5);
    expect(result.removed).toBe(0);
  });

  it("collapses to one-per-day in the 24h-7d window", async () => {
    const mod = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");

    // Inject manifest entries at synthetic timestamps spanning a week.
    // recordPreWrite uses real Date.now(); we bypass it by writing
    // manifest lines directly — tests the prune algorithm in isolation
    // against the real list() reader.
    const manifestPath = path.join(tmpHome, ".minder", "config-history", "manifest.jsonl");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });

    const now = Date.now();
    const oneDay = 24 * 60 * 60_000;
    const twoDaysAgo = new Date(now - 2 * oneDay).toISOString();
    const twoDaysAgoLater = new Date(now - 2 * oneDay + 60_000).toISOString();
    const fourDaysAgo = new Date(now - 4 * oneDay).toISOString();
    const inputs = [
      { id: "a", timestamp: twoDaysAgo,      targetPath: target, contentSha: "deadbeef", wasMissing: false },
      { id: "b", timestamp: twoDaysAgoLater, targetPath: target, contentSha: "deadbeef", wasMissing: false },
      { id: "c", timestamp: fourDaysAgo,     targetPath: target, contentSha: "cafebabe", wasMissing: false },
    ];
    await fs.writeFile(manifestPath, inputs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const result = await mod.prune(now);
    // Two entries on day -2 collapse to one (same day bucket); day -4 keeps its one.
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
  });

  it("drops entries older than 30 days", async () => {
    const mod = await reloadModule();
    const target = path.join(tmpHome, "x.json");
    const manifestPath = path.join(tmpHome, ".minder", "config-history", "manifest.jsonl");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });

    const now = Date.now();
    const oneDay = 24 * 60 * 60_000;
    const ancient = new Date(now - 60 * oneDay).toISOString();
    const recent = new Date(now - 1 * oneDay + 30_000).toISOString();
    const inputs = [
      { id: "old", timestamp: ancient, targetPath: target, contentSha: "x", wasMissing: false },
      { id: "new", timestamp: recent,  targetPath: target, contentSha: "y", wasMissing: false },
    ];
    await fs.writeFile(manifestPath, inputs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const result = await mod.prune(now);
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);

    const remaining = await mod.list();
    expect(remaining.map((e) => e.id)).toEqual(["new"]);
  });
});
