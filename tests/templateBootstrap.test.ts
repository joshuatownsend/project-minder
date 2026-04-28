import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { bootstrapNewProject } from "@/lib/template/bootstrap";
import type { MinderConfig } from "@/lib/types";

let tmp: string;
let config: MinderConfig;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bootstrap-test-"));
  config = {
    statuses: {},
    hidden: [],
    portOverrides: {},
    devRoot: tmp,
    devRoots: [tmp],
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("bootstrapNewProject — happy path", () => {
  it("creates the directory with gitInit:false (no git dependency)", async () => {
    const r = await bootstrapNewProject(config, {
      name: "fresh",
      relPath: "fresh",
      gitInit: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.createdPath).toBe(path.join(tmp, "fresh"));
      expect(r.gitInitialized).toBe(false);
      const stat = await fs.stat(r.createdPath);
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("creates intermediate directories for nested relPath", async () => {
    const r = await bootstrapNewProject(config, {
      name: "deep",
      relPath: "subdir/nested",
      gitInit: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const stat = await fs.stat(r.createdPath);
      expect(stat.isDirectory()).toBe(true);
    }
  });
});

describe("bootstrapNewProject — refusals", () => {
  it("refuses when target already exists", async () => {
    await fs.mkdir(path.join(tmp, "taken"), { recursive: true });
    const r = await bootstrapNewProject(config, { name: "taken", relPath: "taken", gitInit: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TARGET_EXISTS");
  });

  it("refuses an absolute relPath", async () => {
    const r = await bootstrapNewProject(config, {
      name: "abs",
      relPath: path.resolve(tmp, "outside"),
      gitInit: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ABSOLUTE_REL_PATH");
  });

  it("refuses an empty relPath", async () => {
    const r = await bootstrapNewProject(config, { name: "x", relPath: "", gitInit: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EMPTY_REL_PATH");
  });

  it("refuses a path that escapes the dev root via ..", async () => {
    const r = await bootstrapNewProject(config, {
      name: "escape",
      relPath: "../escape",
      gitInit: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_OUTSIDE_DEV_ROOTS");
  });

  it("refuses a path inside <devRoot>/.minder/", async () => {
    const r = await bootstrapNewProject(config, {
      name: "minder",
      relPath: ".minder/templates/foo",
      gitInit: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PATH_INSIDE_MINDER");
  });
});
