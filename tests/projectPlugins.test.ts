import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  scanProjectPluginEnables,
  listEnabledPluginKeys,
} from "@/lib/scanner/projectPlugins";

let tmp: string;
let projectPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "projectPlugins-test-"));
  projectPath = path.join(tmp, "proj");
  await fs.mkdir(path.join(projectPath, ".claude"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("scanProjectPluginEnables", () => {
  it("returns empty list when settings files are missing", async () => {
    const r = await scanProjectPluginEnables(projectPath);
    expect(r).toEqual([]);
  });

  it("parses enabledPlugins from settings.json", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "review@official": true, "lint@official": false } }),
      "utf-8"
    );
    const r = await scanProjectPluginEnables(projectPath);
    expect(r.map((e) => e.key)).toEqual(["lint@official", "review@official"]);
    expect(r.find((e) => e.key === "review@official")?.enabled).toBe(true);
    expect(r.find((e) => e.key === "lint@official")?.enabled).toBe(false);
    expect(r.every((e) => e.source === "project")).toBe(true);
  });

  it("local settings override project settings on key collision", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "x@y": false } }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "x@y": true, "extra@z": true } }),
      "utf-8"
    );
    const r = await scanProjectPluginEnables(projectPath);
    const xy = r.find((e) => e.key === "x@y");
    expect(xy?.enabled).toBe(true);
    expect(xy?.source).toBe("local");
    expect(r.find((e) => e.key === "extra@z")?.enabled).toBe(true);
  });

  it("splits keys on the LAST `@` so scoped names with embedded @ work", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "@scope/name@market": true } }),
      "utf-8"
    );
    const r = await scanProjectPluginEnables(projectPath);
    expect(r[0].name).toBe("@scope/name");
    expect(r[0].marketplace).toBe("market");
  });

  it("treats keys without `@` as having no marketplace", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { naked: true } }),
      "utf-8"
    );
    const r = await scanProjectPluginEnables(projectPath);
    expect(r[0].name).toBe("naked");
    expect(r[0].marketplace).toBe("");
  });
});

describe("listEnabledPluginKeys", () => {
  it("filters out explicit `false` entries", async () => {
    await fs.writeFile(
      path.join(projectPath, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { on: true, off: false, "x@y": true } }),
      "utf-8"
    );
    const r = await listEnabledPluginKeys(projectPath);
    expect(r.sort()).toEqual(["on", "x@y"]);
  });
});
