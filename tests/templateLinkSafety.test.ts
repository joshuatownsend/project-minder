import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ensureInsideDevRoots, PathSafetyError, canonicalPath, assertContained } from "@/lib/template/pathSafety";
import { copyDirRecursive } from "@/lib/template/atomicFs";
import { applySingleFile, applyDirectory } from "@/lib/template/applyFile";
import type { MinderConfig } from "@/lib/types";

// #633 / #640 — real links on disk. A junction needs no privilege on Windows and is a plain dir symlink on POSIX.
let tmp: string;
let root: string;
let outside: string;

async function link(target: string, at: string) {
  await fs.symlink(target, at, "junction");
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "linksafe-")));
  root = path.join(tmp, "root");
  outside = path.join(tmp, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (): MinderConfig => ({ statuses: {}, hidden: [], portOverrides: {}, devRoot: root, devRoots: [root] });

describe("ensureInsideDevRoots follows links (#633)", () => {
  it("refuses a project whose parent link leaves the dev root", async () => {
    await fs.mkdir(path.join(root, "proj"));
    await link(outside, path.join(root, "proj", ".claude"));
    expect(() => ensureInsideDevRoots(path.join(root, "proj", ".claude", "agents", "x.md"), cfg())).toThrow(PathSafetyError);
  });

  it("refuses a link that points into .minder", async () => {
    await fs.mkdir(path.join(root, ".minder"));
    await link(path.join(root, ".minder"), path.join(root, "sneaky"));
    expect(() => ensureInsideDevRoots(path.join(root, "sneaky", "state"), cfg())).toThrow(/minder/i);
  });

  it("still accepts ordinary, not-yet-existing paths and links that stay inside", async () => {
    await fs.mkdir(path.join(root, "real"));
    await link(path.join(root, "real"), path.join(root, "alias"));
    expect(ensureInsideDevRoots(path.join(root, "alias", "new", "file.md"), cfg())).toBe(path.join(root, "alias", "new", "file.md"));
  });

  it("canonicalPath resolves the deepest existing ancestor", async () => {
    await link(outside, path.join(root, "l"));
    expect(canonicalPath(path.join(root, "l", "a", "b"))).toBe(path.join(outside, "a", "b"));
  });
});

describe("source and target containment (#633, #640)", () => {
  it("applySingleFile refuses a source that resolves outside the source root", async () => {
    const proj = path.join(tmp, "srcproj");
    await fs.mkdir(proj);
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    await link(outside, path.join(proj, "l"));
    const r = await applySingleFile({
      sourcePath: path.join(proj, "l", "secret.md"),
      targetPath: path.join(root, "out.md"),
      conflict: "overwrite",
      sourceRoot: proj,
    });
    expect(r.ok).toBe(false);
    await expect(fs.access(path.join(root, "out.md"))).rejects.toThrow();
  });

  it("applySingleFile refuses to write through a target parent link", async () => {
    const src = path.join(tmp, "s.md");
    await fs.writeFile(src, "x");
    await link(outside, path.join(root, ".claude"));
    const r = await applySingleFile({
      sourcePath: src,
      targetPath: path.join(root, ".claude", "agents", "a.md"),
      conflict: "overwrite",
      targetRoot: root,
    });
    expect(r.ok).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("copyDirRecursive skips links that leave the root and survives a cycle", async () => {
    const src = path.join(tmp, "skill");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "SKILL.md"), "ok");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    await link(outside, path.join(src, "escape"));
    await link(src, path.join(src, "loop"));
    const dest = path.join(tmp, "dest");
    const written = await copyDirRecursive(src, dest, { containRoot: src });
    expect(written.map((w) => path.relative(dest, w))).toEqual(["SKILL.md"]);
    await expect(fs.access(path.join(dest, "escape"))).rejects.toThrow();
  });

  it("copyDirRecursive terminates on a cycle even without a root", async () => {
    const src = path.join(tmp, "cyc");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.md"), "a");
    await link(src, path.join(src, "loop"));
    const written = await copyDirRecursive(src, path.join(tmp, "d2"));
    expect(written.length).toBe(1);
  });

  it("copyDirRecursive refuses a destination entry that is a link", async () => {
    const src = path.join(tmp, "s3");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "a.md"), "a");
    const dest = path.join(tmp, "d3");
    await fs.mkdir(dest);
    await link(outside, path.join(dest, "a.md"));
    await expect(copyDirRecursive(src, dest)).rejects.toThrow(/symlink|junction/);
  });

  it("applyDirectory enforces both roots", async () => {
    const src = path.join(tmp, "s4");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "SKILL.md"), "x");
    await link(outside, path.join(root, ".claude"));
    const r = await applyDirectory({
      sourceDir: src,
      targetDir: path.join(root, ".claude", "skills", "s"),
      conflict: "overwrite",
      sourceRoot: src,
      targetRoot: root,
    });
    expect(r.ok).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("assertContained accepts ordinary descendants", () => {
    expect(() => assertContained(path.join(root, "a", "b"), root)).not.toThrow();
  });
});

describe("project configuration locations (#633, #640)", () => {
  it("assertProjectConfigContained refuses a .github or .claude link leaving the project", async () => {
    const { assertProjectConfigContained } = await import("@/lib/template/pathSafety");
    const proj = path.join(root, "p");
    await fs.mkdir(proj);
    expect(() => assertProjectConfigContained(proj)).not.toThrow();
    await link(outside, path.join(proj, ".github"));
    expect(() => assertProjectConfigContained(proj)).toThrow(PathSafetyError);
  });

  it("protects the real location of a relocated .minder directory", async () => {
    await fs.mkdir(path.join(root, "state"));
    await link(path.join(root, "state"), path.join(root, ".minder"));
    expect(() => ensureInsideDevRoots(path.join(root, "state", "x"), cfg())).toThrow(/minder/i);
  });
});

describe("final-file links and aliases (#633, #640)", () => {
  it("copies two in-root aliases of one directory (only a cycle is skipped)", async () => {
    const src = path.join(tmp, "sk");
    await fs.mkdir(path.join(src, "shared"), { recursive: true });
    await fs.writeFile(path.join(src, "shared", "a.md"), "a");
    await link(path.join(src, "shared"), path.join(src, "alias"));
    const written = await copyDirRecursive(src, path.join(tmp, "dd"), { containRoot: src });
    expect(written.map((w) => path.relative(path.join(tmp, "dd"), w)).sort()).toEqual([path.join("alias", "a.md"), path.join("shared", "a.md")]);
  });

  it("assertProjectConfigContained refuses a settings.json that is a link out of the project", async () => {
    const { assertProjectConfigContained } = await import("@/lib/template/pathSafety");
    const proj = path.join(root, "q");
    await fs.mkdir(path.join(proj, ".claude"), { recursive: true });
    await fs.writeFile(path.join(outside, "s.json"), "{}");
    await fs.symlink(path.join(outside, "s.json"), path.join(proj, ".claude", "settings.json"), "file").catch(() => undefined);
    const linked = await fs.lstat(path.join(proj, ".claude", "settings.json")).then((st) => st.isSymbolicLink(), () => false);
    if (!linked) return; // file symlinks need privilege on some Windows setups
    expect(() => assertProjectConfigContained(proj)).toThrow(PathSafetyError);
  });

  it("applyWorkflow refuses a workflow file that links out of the source project", async () => {
    const { applyWorkflow } = await import("@/lib/template/applyWorkflow");
    const srcProj = path.join(root, "w");
    await fs.mkdir(path.join(srcProj, ".github"), { recursive: true });
    await fs.writeFile(path.join(outside, "ci.yml"), "name: x");
    await link(outside, path.join(srcProj, ".github", "workflows"));
    const r = await applyWorkflow({ sourceProjectPath: srcProj, workflowKey: "ci.yml", targetProjectPath: path.join(root, "t"), conflict: "overwrite" });
    expect(r.ok).toBe(false);
  });
});
