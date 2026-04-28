import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { listTemplates, templateExists } from "@/lib/template/registry";
import { buildManifest, manifestPathForSlug, templateDirForSlug, writeManifest } from "@/lib/template/manifest";
import type { MinderConfig } from "@/lib/types";

let tmp: string;
let config: MinderConfig;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
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

describe("listTemplates", () => {
  it("returns empty arrays when templates root does not exist", async () => {
    const r = await listTemplates(config);
    expect(r.manifests).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("lists valid manifests sorted by updatedAt desc", async () => {
    const a = buildManifest({ slug: "alpha", name: "A", kind: "live", liveSourceSlug: "src" });
    const b = buildManifest({ slug: "beta", name: "B", kind: "snapshot" });
    // Force b to be newer.
    b.updatedAt = new Date(Date.now() + 1000).toISOString();
    await writeManifest(config, a);
    await writeManifest(config, b);

    const r = await listTemplates(config);
    expect(r.manifests.map((m) => m.slug)).toEqual(["beta", "alpha"]);
    expect(r.errors).toEqual([]);
  });

  it("skips directories with invalid slug names", async () => {
    const dir = path.join(tmp, ".minder", "templates", "BadCaps");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "template.json"), "{}", "utf-8");
    const r = await listTemplates(config);
    expect(r.manifests).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("reports manifests that fail to parse as errors", async () => {
    const dir = templateDirForSlug(config, "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(manifestPathForSlug(config, "broken"), "{ not json", "utf-8");
    const r = await listTemplates(config);
    expect(r.manifests).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].slug).toBe("broken");
  });

  it("reports manifests that fail validation", async () => {
    const dir = templateDirForSlug(config, "incomplete");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      manifestPathForSlug(config, "incomplete"),
      JSON.stringify({ schemaVersion: 1 }),
      "utf-8"
    );
    const r = await listTemplates(config);
    expect(r.manifests).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it("reports a directory missing template.json", async () => {
    const dir = templateDirForSlug(config, "empty");
    await fs.mkdir(dir, { recursive: true });
    const r = await listTemplates(config);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/no template\.json/);
  });
});

describe("templateExists", () => {
  it("returns false for unknown slug", async () => {
    expect(await templateExists(config, "missing")).toBe(false);
  });
  it("returns true after writeManifest", async () => {
    const m = buildManifest({ slug: "yes", name: "y", kind: "live", liveSourceSlug: "src" });
    await writeManifest(config, m);
    expect(await templateExists(config, "yes")).toBe(true);
  });
});
