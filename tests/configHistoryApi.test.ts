import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Tests for the /api/config-history GET route. Pins:
//   1. snapshotPath is stripped from the response (server-local FS path
//      must not leak to the browser — Copilot review on PR #59).
//   2. The route still surfaces every other manifest field unchanged.
//   3. project=<slug> resolves the slug to the project's path and scopes by that (#635).

let tmpHome: string;

async function reloadRoute() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.doMock("@/lib/projectPath", () => ({
    getScannedProjects: async () =>
      ["demo", "alpha", "beta"].map((slug) => ({ slug, path: path.join(tmpHome, slug) })).concat([
        // Nested inside "alpha", as when another dev root sits inside a project.
        { slug: "alpha-child", path: path.join(tmpHome, "alpha", "child") },
      ]),
  }));
  const route = await import("@/app/api/config-history/route");
  const config = await import("@/lib/configHistory");
  return { route, config };
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pm-history-api-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.rm(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeRequest(url: string) {
  // The route only reads .nextUrl.searchParams.get("project"). A minimal
  // shim is sufficient; we don't need the full NextRequest.
  return { nextUrl: new URL(url) } as unknown as import("next/server").NextRequest;
}

describe("/api/config-history GET", () => {
  it("strips server-local snapshotPath from each entry in the response", async () => {
    const { route, config } = await reloadRoute();
    const target = path.join(tmpHome, "settings.json");
    await fs.writeFile(target, '{"x":1}', "utf-8");
    await config.recordPreWrite(target, { projectSlug: "demo", projectPath: path.join(tmpHome, "demo") });

    const res = await route.GET(makeRequest("http://x/api/config-history?project=demo"));
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0];

    // The leaked-path field must not appear.
    expect(entry).not.toHaveProperty("snapshotPath");

    // Sanity: the legitimate fields ARE still present.
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("targetPath");
    expect(entry).toHaveProperty("contentSha");
    expect(entry).toHaveProperty("wasMissing", false);
    expect(entry).toHaveProperty("projectSlug", "demo");

    // Belt-and-braces: the entire serialized response should not mention
    // the path under ~/.minder/config-history/ — a future refactor
    // accidentally re-adding the field would regress this string match.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(".minder/config-history");
    expect(serialized).not.toContain(".minder\\config-history");
  });

  it("filters by the path ?project=<slug> resolves to, not by the recorded slug", async () => {
    const { route, config } = await reloadRoute();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");
    // The slug "alpha" was recorded against the beta project's path, as after a root reorder (#635).
    await config.recordPreWrite(target, { projectSlug: "alpha", projectPath: path.join(tmpHome, "beta") });
    await config.recordPreWrite(target, { projectSlug: "beta", projectPath: path.join(tmpHome, "alpha") });

    const alphaRes = await route.GET(makeRequest("http://x/api/config-history?project=alpha"));
    const alphaBody = (await alphaRes.json()) as { entries: Array<{ projectPath: string }> };
    expect(alphaBody.entries).toHaveLength(1);
    expect(alphaBody.entries[0].projectPath).toBe(path.join(tmpHome, "alpha"));
  });

  it("keeps a nested project's older snapshots off its parent's tab", async () => {
    const { route, config } = await reloadRoute();
    const parentFile = path.join(tmpHome, "alpha", "CLAUDE.md");
    const childFile = path.join(tmpHome, "alpha", "child", "CLAUDE.md");
    await fs.mkdir(path.dirname(childFile), { recursive: true });
    await fs.writeFile(parentFile, "p", "utf-8");
    await fs.writeFile(childFile, "c", "utf-8");
    // Recorded before #635: a slug only, no project path.
    await config.recordPreWrite(parentFile, { projectSlug: "alpha" });
    await config.recordPreWrite(childFile, { projectSlug: "alpha-child" });

    const get = async (slug: string) =>
      ((await (await route.GET(makeRequest(`http://x/api/config-history?project=${slug}`))).json()) as {
        entries: Array<{ targetPath: string }>;
      }).entries.map((e) => e.targetPath);
    expect(await get("alpha")).toEqual([path.resolve(parentFile)]);
    expect(await get("alpha-child")).toEqual([path.resolve(childFile)]);
  });

  it("returns no entries for a slug that names no project", async () => {
    const { route, config } = await reloadRoute();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");
    await config.recordPreWrite(target, { projectSlug: "ghost" });

    const res = await route.GET(makeRequest("http://x/api/config-history?project=ghost"));
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it("returns empty entries (not 500) when manifest does not exist", async () => {
    const { route } = await reloadRoute();
    const res = await route.GET(makeRequest("http://x/api/config-history"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
