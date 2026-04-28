import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { applySingleFile, applyDirectory } from "@/lib/template/applyFile";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "applyFile-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("applySingleFile", () => {
  it("creates parent dirs and writes content for new target", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "out", "nested", "dst.md");
    await fs.writeFile(source, "hello", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "skip",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("applied");
    expect(result.changedFiles).toEqual([target]);
    expect(await fs.readFile(target, "utf-8")).toBe("hello");
  });

  it("skips when target exists and conflict=skip", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "dst.md");
    await fs.writeFile(source, "new", "utf-8");
    await fs.writeFile(target, "existing", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "skip",
    });

    expect(result.status).toBe("skipped");
    expect(await fs.readFile(target, "utf-8")).toBe("existing");
  });

  it("overwrites when conflict=overwrite", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "dst.md");
    await fs.writeFile(source, "new", "utf-8");
    await fs.writeFile(target, "existing", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "overwrite",
    });

    expect(result.status).toBe("applied");
    expect(await fs.readFile(target, "utf-8")).toBe("new");
  });

  it("renames to .copy.md when conflict=rename", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "dst.md");
    await fs.writeFile(source, "new", "utf-8");
    await fs.writeFile(target, "existing", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "rename",
    });

    expect(result.status).toBe("applied");
    expect(result.changedFiles[0]).toBe(path.join(tmp, "dst.copy.md"));
    expect(await fs.readFile(target, "utf-8")).toBe("existing");
    expect(await fs.readFile(path.join(tmp, "dst.copy.md"), "utf-8")).toBe("new");
  });

  it("renames to .copy2.md when .copy.md is also taken", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "dst.md");
    await fs.writeFile(source, "v3", "utf-8");
    await fs.writeFile(target, "v1", "utf-8");
    await fs.writeFile(path.join(tmp, "dst.copy.md"), "v2", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "rename",
    });

    expect(result.changedFiles[0]).toBe(path.join(tmp, "dst.copy2.md"));
  });

  it("dryRun returns would-apply with diff preview, no write", async () => {
    const source = path.join(tmp, "src.md");
    const target = path.join(tmp, "dst.md");
    await fs.writeFile(source, "new", "utf-8");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "skip",
      dryRun: true,
    });

    expect(result.status).toBe("would-apply");
    expect(result.diffPreview).toContain("[new file]");
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("returns error when source is unreadable", async () => {
    const source = path.join(tmp, "missing.md");
    const target = path.join(tmp, "dst.md");

    const result = await applySingleFile({
      sourcePath: source,
      targetPath: target,
      conflict: "skip",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SOURCE_READ_FAILED");
  });
});

describe("applyDirectory", () => {
  it("recursively copies a directory tree", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    await fs.mkdir(path.join(src, "sub"), { recursive: true });
    await fs.writeFile(path.join(src, "SKILL.md"), "skill", "utf-8");
    await fs.writeFile(path.join(src, "sub", "helper.md"), "helper", "utf-8");

    const result = await applyDirectory({
      sourceDir: src,
      targetDir: dst,
      conflict: "skip",
    });

    expect(result.status).toBe("applied");
    expect(await fs.readFile(path.join(dst, "SKILL.md"), "utf-8")).toBe("skill");
    expect(await fs.readFile(path.join(dst, "sub", "helper.md"), "utf-8")).toBe("helper");
  });

  it("skips when target dir exists and conflict=skip", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });
    await fs.writeFile(path.join(src, "SKILL.md"), "src", "utf-8");
    await fs.writeFile(path.join(dst, "SKILL.md"), "existing", "utf-8");

    const result = await applyDirectory({
      sourceDir: src,
      targetDir: dst,
      conflict: "skip",
    });

    expect(result.status).toBe("skipped");
    expect(await fs.readFile(path.join(dst, "SKILL.md"), "utf-8")).toBe("existing");
  });

  it("removes target dir before re-creating when conflict=overwrite", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });
    await fs.writeFile(path.join(src, "SKILL.md"), "new", "utf-8");
    await fs.writeFile(path.join(dst, "SKILL.md"), "old", "utf-8");
    await fs.writeFile(path.join(dst, "obsolete.md"), "stale", "utf-8");

    const result = await applyDirectory({
      sourceDir: src,
      targetDir: dst,
      conflict: "overwrite",
    });

    expect(result.status).toBe("applied");
    expect(await fs.readFile(path.join(dst, "SKILL.md"), "utf-8")).toBe("new");
    // obsolete.md should be gone — overwrite removes the entire prior dir.
    await expect(fs.access(path.join(dst, "obsolete.md"))).rejects.toThrow();
  });

  it("renames to .copy when conflict=rename", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });
    await fs.writeFile(path.join(src, "SKILL.md"), "src", "utf-8");
    await fs.writeFile(path.join(dst, "SKILL.md"), "existing", "utf-8");

    const result = await applyDirectory({
      sourceDir: src,
      targetDir: dst,
      conflict: "rename",
    });

    expect(result.status).toBe("applied");
    expect(await fs.readFile(path.join(tmp, "dst.copy", "SKILL.md"), "utf-8")).toBe("src");
    expect(await fs.readFile(path.join(dst, "SKILL.md"), "utf-8")).toBe("existing");
  });
});
