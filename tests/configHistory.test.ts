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

describe("recordPreWrite projectSlug semantics (post-PR-#59 review)", () => {
  it("records the caller-supplied projectSlug verbatim", async () => {
    // The slug-fallback fix lives in apply.ts (resolveProjectSlugForSnapshot),
    // not in configHistory itself. configHistory's contract is just to
    // record whatever slug the caller passes, so pin that contract here
    // — the apply-layer slug derivation is exercised through
    // applyDispatch.test.ts.
    const { recordPreWrite, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x":1}', "utf-8");

    await recordPreWrite(target, { projectSlug: "fresh-bootstrap" });
    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0].projectSlug).toBe("fresh-bootstrap");
  });
});

describe("makeId uniqueness (post-PR-#59 review)", () => {
  it(
    "generates distinct BackupIds for concurrent recordPreWrite on identical content",
    // Higher timeout: 20 concurrent recordPreWrite triggers 20 manifest
    // appends + up to 20 maybePrune attempts, all serializing through
    // the manifest lock plus AsyncLocalStorage propagation overhead.
    // Default 5s can flake under parallel-pool I/O contention on Windows
    // CI; 15s gives plenty of headroom while still catching real hangs.
    { timeout: 15_000 },
    async () => {
      // Pre-fix the id was `<iso>_<sha8|missing>` with ms-timestamp resolution,
      // so two recordPreWrite calls in the same millisecond on identical bytes
      // (or two missing-file snapshots) collided. Random suffix is the only
      // collision guard — pin it with a concurrent burst.
      const { recordPreWrite, list } = await reloadModule();
      const target = path.join(tmpHome, "settings.json");
      await fs.writeFile(target, '{"x":1}', "utf-8");

      const N = 20;
      const ids = await Promise.all(
        Array.from({ length: N }, () => recordPreWrite(target)),
      );
      expect(ids.every((id) => id !== null)).toBe(true);
      expect(new Set(ids).size).toBe(N);

      const entries = await list();
      expect(entries).toHaveLength(N);
      expect(new Set(entries.map((e) => e.id)).size).toBe(N);
    },
  );

  it("generates distinct BackupIds for two missing-file snapshots in the same ms", async () => {
    const { recordPreWrite } = await reloadModule();
    const absent = path.join(tmpHome, "absent.json");
    const [a, b] = await Promise.all([recordPreWrite(absent), recordPreWrite(absent)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("restore byte-fidelity (post-PR-#59 review)", () => {
  it("round-trips non-UTF-8 / binary content unchanged", async () => {
    // Pre-fix `restore` did `.toString("base64") → Buffer → .toString("utf-8")
    // → write`. The utf-8 transcoding mangles any byte outside the valid
    // utf-8 grammar (lone surrogates, raw 0xFF, etc.). Pin byte-faithful
    // restore by snapshotting raw bytes that don't form valid utf-8 and
    // asserting bit-exact equality after restore.
    const { recordPreWrite, restore } = await reloadModule();
    const target = path.join(tmpHome, "binary.bin");
    const original = Buffer.from([
      0x00, 0xff, 0xfe, 0xfd, 0xc0, 0x80, // overlong + invalid utf-8 bytes
      0xed, 0xa0, 0x80, // unpaired surrogate (invalid utf-8)
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, // PNG header bytes
    ]);
    await fs.writeFile(target, original);

    const id = await recordPreWrite(target);
    expect(id).not.toBeNull();
    await fs.writeFile(target, "mutated to text");

    await restore(id!);
    const restored = await fs.readFile(target);
    expect(restored.equals(original)).toBe(true);
  });
});

describe("restore concurrency (post-PR-#59 review)", () => {
  it(
    "serializes against concurrent writes via withFileLock(targetPath)",
    { timeout: 10_000 },
    async () => {
      // Wave 1.2 follow-up #5 (Codex P2): restore() previously mutated
      // entry.targetPath without withFileLock, so an apply mid-flight on
      // the same file could race the restore's write.
      //
      // Test strategy: grab the target's lock from outside, then start a
      // restore. With the lock held, restore must queue (it should be
      // calling withFileLock(target) too). Release the held lock — restore
      // proceeds. If restore ignored the lock, it would race past the
      // outer holder; if restore acquires the lock, it queues correctly.
      // Verify ordering by recording timestamps.
      const { recordPreWrite, restore } = await reloadModule();
      const { withFileLock } = await import("@/lib/atomicWrite");
      const target = path.join(tmpHome, "settings.json");
      await fs.writeFile(target, "v1", "utf-8");
      const id = await recordPreWrite(target);
      expect(id).not.toBeNull();
      await fs.writeFile(target, "v2", "utf-8");

      const events: string[] = [];
      let releaseHolder!: () => void;
      const holderReady = new Promise<void>((r) => { releaseHolder = r; });

      // Outer holder: grabs the lock, signals it's holding, waits for
      // explicit release.
      let holderGotLock!: () => void;
      const holderHasLock = new Promise<void>((r) => { holderGotLock = r; });
      const holderPromise = withFileLock(target, async () => {
        events.push("holder-acquired");
        holderGotLock();
        await holderReady; // hold until release
        events.push("holder-releasing");
      });

      await holderHasLock;
      // Now start restore — it must queue behind the holder. If the
      // restore-under-lock fix isn't in place, restore would proceed
      // immediately and "restore-done" would land before "holder-releasing".
      const restorePromise = (async () => {
        await restore(id!);
        events.push("restore-done");
      })();

      // Give restore a tick to attempt the lock. If it weren't blocked,
      // it would complete here (the work is small).
      await new Promise((r) => setTimeout(r, 50));
      expect(events).toEqual(["holder-acquired"]); // restore is queued

      releaseHolder();
      await Promise.all([holderPromise, restorePromise]);

      // Order must be: holder releases → restore runs → restore-done.
      expect(events).toEqual(["holder-acquired", "holder-releasing", "restore-done"]);
      expect(await fs.readFile(target, "utf-8")).toBe("v1");
    },
  );
});

describe("removeBackup (post-PR-#59 review)", () => {
  it("removes the manifest entry and the snapshot directory", async () => {
    const { recordPreWrite, removeBackup, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x":1}', "utf-8");

    const id = await recordPreWrite(target);
    expect(id).not.toBeNull();
    const before = await list();
    expect(before).toHaveLength(1);
    const snapshotDir = path.join(tmpHome, ".minder", "config-history", id!);
    await expect(fs.access(snapshotDir)).resolves.toBeUndefined();

    await removeBackup(id!);

    const after = await list();
    expect(after).toHaveLength(0);
    await expect(fs.access(snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves untargeted entries when removing one", async () => {
    const { recordPreWrite, removeBackup, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x":1}', "utf-8");

    const a = await recordPreWrite(target);
    const b = await recordPreWrite(target);
    const c = await recordPreWrite(target);
    expect(new Set([a, b, c]).size).toBe(3);

    await removeBackup(b!);
    const remaining = await list();
    expect(remaining.map((e) => e.id).sort()).toEqual([a!, c!].sort());
  });

  it("is a no-op (and does not throw) when the id is unknown", async () => {
    const { recordPreWrite, removeBackup, list } = await reloadModule();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x":1}', "utf-8");
    const id = await recordPreWrite(target);

    await expect(removeBackup("nonexistent-id")).resolves.toBeUndefined();
    const entries = await list();
    expect(entries.map((e) => e.id)).toEqual([id]);
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
