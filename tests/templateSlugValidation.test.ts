import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import type { MinderConfig } from "@/lib/types";

// #636 — the template routes forwarded a decoded slug (which can contain `..` and separators) to
// path.join + fs.rm(recursive). Every handler must refuse it, and the path helpers must throw.

let tmp: string;
let config: MinderConfig;

vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  readConfig: vi.fn(async () => config),
}));
vi.mock("@/lib/demo/demoWriteGuard", () => ({ demoWriteBlock: vi.fn(async () => null) }));

import { templateDirForSlug, manifestPathForSlug, bundleDirForSlug } from "@/lib/template/manifest";
import { deleteTemplate } from "@/lib/template/promote";
import { GET, DELETE, PATCH } from "@/app/api/templates/[slug]/route";
import { POST as APPLY } from "@/app/api/templates/[slug]/apply/route";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tmpl-slug-"));
  config = { statuses: {}, hidden: [], portOverrides: {}, devRoot: tmp, devRoots: [tmp] };
  await fs.mkdir(path.join(tmp, ".minder", "templates", "real"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".minder", "templates", "real", "template.json"), "{}");
  await fs.mkdir(path.join(tmp, "victim"));
  await fs.writeFile(path.join(tmp, "victim", "keep.txt"), "x");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const BAD = ["..", "../victim", "../../victim", "a/b", String.raw`a\b`, "Real", "-x", "", "x".repeat(65)];

describe("template slug validation (#636)", () => {
  it.each(BAD)("path helpers throw for %j", (slug) => {
    expect(() => templateDirForSlug(config, slug)).toThrow();
    expect(() => manifestPathForSlug(config, slug)).toThrow();
    expect(() => bundleDirForSlug(config, slug)).toThrow();
  });

  it.each(BAD)("deleteTemplate refuses %j and removes nothing", async (slug) => {
    await expect(deleteTemplate(config, slug)).rejects.toThrow();
    expect(await fs.readFile(path.join(tmp, "victim", "keep.txt"), "utf-8")).toBe("x");
    expect(await fs.readdir(path.join(tmp, ".minder", "templates"))).toEqual(["real"]);
  });

  it.each(["../../victim", "..", "a/b"])("every handler answers 400 for %j and leaves the disk alone", async (slug) => {
    const ctx = { params: Promise.resolve({ slug }) };
    const mk = (method: string, body?: unknown) =>
      new NextRequest("http://localhost:4100/api/templates/x", { method, body: body ? JSON.stringify(body) : undefined });
    expect((await GET(mk("GET"), ctx)).status).toBe(400);
    expect((await DELETE(mk("DELETE"), ctx)).status).toBe(400);
    expect((await PATCH(mk("PATCH", { action: "snapshot" }), ctx)).status).toBe(400);
    expect((await APPLY(mk("POST", { targets: [] }), ctx)).status).toBe(400);
    expect(await fs.readFile(path.join(tmp, "victim", "keep.txt"), "utf-8")).toBe("x");
  });

  it("a normal slug still deletes its own directory", async () => {
    await deleteTemplate(config, "real");
    await expect(fs.access(path.join(tmp, ".minder", "templates", "real"))).rejects.toThrow();
    expect(await fs.readFile(path.join(tmp, "victim", "keep.txt"), "utf-8")).toBe("x");
  });
});
