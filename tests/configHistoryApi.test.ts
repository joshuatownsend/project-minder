import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import { promises as fs } from "fs";

// Tests for the /api/config-history GET route. Pins:
//   1. snapshotPath is stripped from the response (server-local FS path
//      must not leak to the browser — Copilot review on PR #59).
//   2. The route still surfaces every other manifest field unchanged.
//   3. project=<slug> filter passes through to list().

let tmpHome: string;

async function reloadRoute() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
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
    await config.recordPreWrite(target, { projectSlug: "demo" });

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

  it("filters by ?project=<slug>", async () => {
    const { route, config } = await reloadRoute();
    const target = path.join(tmpHome, "x.json");
    await fs.writeFile(target, "x", "utf-8");
    await config.recordPreWrite(target, { projectSlug: "alpha" });
    await config.recordPreWrite(target, { projectSlug: "beta" });

    const alphaRes = await route.GET(makeRequest("http://x/api/config-history?project=alpha"));
    const alphaBody = (await alphaRes.json()) as { entries: Array<{ projectSlug: string }> };
    expect(alphaBody.entries).toHaveLength(1);
    expect(alphaBody.entries[0].projectSlug).toBe("alpha");
  });

  it("returns empty entries (not 500) when manifest does not exist", async () => {
    const { route } = await reloadRoute();
    const res = await route.GET(makeRequest("http://x/api/config-history"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
