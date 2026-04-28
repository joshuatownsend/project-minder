import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  buildManifest,
  emptyInventory,
  inventoryCount,
  isValidSlug,
  manifestPathForSlug,
  readManifest,
  templateDirForSlug,
  templatesRootForConfig,
  validateManifest,
  writeManifest,
} from "@/lib/template/manifest";
import type { MinderConfig } from "@/lib/types";

let tmp: string;
let config: MinderConfig;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-test-"));
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

describe("isValidSlug", () => {
  it("accepts simple slugs", () => {
    expect(isValidSlug("my-template")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("a1b2c3")).toBe(true);
  });
  it("rejects invalid forms", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("My-Template")).toBe(false);
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("with spaces")).toBe(false);
    expect(isValidSlug("with/slash")).toBe(false);
    expect(isValidSlug("a".repeat(65))).toBe(false);
  });
});

describe("path helpers", () => {
  it("templatesRootForConfig returns <devRoot>/.minder/templates", () => {
    expect(templatesRootForConfig(config)).toBe(path.join(tmp, ".minder", "templates"));
  });
  it("templateDirForSlug nests under templatesRoot", () => {
    expect(templateDirForSlug(config, "x")).toBe(path.join(tmp, ".minder", "templates", "x"));
  });
  it("manifestPathForSlug ends in template.json", () => {
    expect(manifestPathForSlug(config, "x")).toBe(path.join(tmp, ".minder", "templates", "x", "template.json"));
  });
});

describe("buildManifest", () => {
  it("creates a live manifest with timestamps", () => {
    const m = buildManifest({
      slug: "demo",
      name: "Demo",
      kind: "live",
      liveSourceSlug: "src",
    });
    expect(m.slug).toBe("demo");
    expect(m.kind).toBe("live");
    expect(m.liveSourceSlug).toBe("src");
    expect(m.createdAt).toEqual(m.updatedAt);
    expect(m.units).toEqual(emptyInventory());
  });
  it("nulls out liveSourceSlug for snapshot kind", () => {
    const m = buildManifest({
      slug: "snap",
      name: "Snapshot",
      kind: "snapshot",
      liveSourceSlug: "ignored",
    });
    expect(m.liveSourceSlug).toBeUndefined();
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const m = buildManifest({ slug: "ok", name: "OK", kind: "live", liveSourceSlug: "x" });
    const r = validateManifest(m);
    expect("manifest" in r).toBe(true);
  });
  it("rejects schemaVersion !== 1", () => {
    const r = validateManifest({ ...buildManifest({ slug: "ok", name: "OK", kind: "live", liveSourceSlug: "x" }), schemaVersion: 2 });
    expect("errors" in r && r.errors.some((e) => e.field === "schemaVersion")).toBe(true);
  });
  it("rejects bad slug", () => {
    const m = buildManifest({ slug: "ok", name: "OK", kind: "live", liveSourceSlug: "x" });
    const r = validateManifest({ ...m, slug: "BadCaps" });
    expect("errors" in r && r.errors.some((e) => e.field === "slug")).toBe(true);
  });
  it("requires liveSourceSlug for live kind", () => {
    const m = buildManifest({ slug: "ok", name: "OK", kind: "live", liveSourceSlug: "x" });
    const r = validateManifest({ ...m, liveSourceSlug: undefined });
    expect("errors" in r && r.errors.some((e) => e.field === "liveSourceSlug")).toBe(true);
  });
  it("rejects bad unit ref", () => {
    const m = buildManifest({ slug: "ok", name: "OK", kind: "live", liveSourceSlug: "x" });
    const bad = { ...m, units: { ...m.units, agents: [{ kind: "agent", key: "" }] } };
    const r = validateManifest(bad);
    expect("errors" in r && r.errors.some((e) => e.field.startsWith("units.agents"))).toBe(true);
  });
});

describe("readManifest / writeManifest", () => {
  it("round-trips a live manifest", async () => {
    const m = buildManifest({ slug: "rt", name: "Round Trip", kind: "live", liveSourceSlug: "src" });
    await writeManifest(config, m);
    const r = await readManifest(config, "rt");
    expect(r && "manifest" in r).toBe(true);
    if (r && "manifest" in r) {
      expect(r.manifest).toEqual(m);
    }
  });
  it("returns undefined when file does not exist", async () => {
    const r = await readManifest(config, "missing");
    expect(r).toBeUndefined();
  });
  it("surfaces validation errors on a malformed manifest", async () => {
    const dir = templateDirForSlug(config, "bad");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(manifestPathForSlug(config, "bad"), JSON.stringify({ schemaVersion: 1 }), "utf-8");
    const r = await readManifest(config, "bad");
    expect(r && "errors" in r).toBe(true);
  });
  it("refuses to write an invalid manifest", async () => {
    const m = buildManifest({ slug: "valid", name: "v", kind: "live", liveSourceSlug: "x" });
    const broken = { ...m, slug: "Bad Caps" };
    await expect(writeManifest(config, broken)).rejects.toThrow(/slug/);
  });
});

describe("inventoryCount", () => {
  it("sums all kinds", () => {
    const m = buildManifest({ slug: "x", name: "x", kind: "live", liveSourceSlug: "y" });
    m.units.agents.push({ kind: "agent", key: "a" });
    m.units.skills.push({ kind: "skill", key: "s:bundled" });
    m.units.commands.push({ kind: "command", key: "c" });
    m.units.hooks.push({ kind: "hook", key: "h|*|deadbeefdeadbeef" });
    m.units.mcp.push({ kind: "mcp", key: "m" });
    expect(inventoryCount(m.units)).toBe(5);
  });
});
