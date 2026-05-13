import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

vi.mock("fs", () => {
  const stat = vi.fn();
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const mkdir = vi.fn();
  return {
    // Mock the promises surface used by cache.ts. `readFileSync` is also
    // exported (as a stub) so any code path importing it from `fs` doesn't
    // crash — but the stub does NOT proxy to the real implementation.
    // The fixture loader below uses `require("node:fs").readFileSync`
    // directly to bypass this mock when it needs real disk reads.
    promises: { stat, readFile, writeFile, mkdir },
    readFileSync: vi.fn(),
  };
});

import { promises as fsP } from "fs";
import {
  _resetForTesting,
  getChanges,
  getCurrentStatus,
  forceRefresh,
} from "@/lib/claudeStatus/cache";

const mockStat = vi.mocked(fsP.stat);
const mockReadFile = vi.mocked(fsP.readFile);
const mockWriteFile = vi.mocked(fsP.writeFile);
const mockMkdir = vi.mocked(fsP.mkdir);

// Bypass the `vi.mock("fs", ...)` above by reaching for the unmocked
// `node:fs` module via require(). Vitest only intercepts the bare "fs"
// specifier, so "node:fs" gives us the real readFileSync we need to
// hydrate the JSON fixtures off disk.
function loadFixture(name: string): unknown {
  const real = require("node:fs").readFileSync as typeof readFileSync;
  const p = path.resolve(__dirname, "fixtures", "claudeStatus", `${name}.json`);
  return JSON.parse(real(p, "utf-8"));
}

const clearPayload = loadFixture("summary-clear");
const incidentPayload = loadFixture("summary-incident");

function mockFetchOk(payload: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  }) as unknown as typeof fetch;
}

function mockFetchFail(message = "boom"): void {
  global.fetch = vi.fn().mockRejectedValue(new Error(message)) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  // Default: no disk cache.
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

afterEach(() => {
  (global as { fetch?: typeof fetch }).fetch = undefined;
});

describe("claudeStatus cache", () => {
  it("fetches live data on first call, marks source=live, writes disk cache", async () => {
    mockFetchOk(clearPayload);
    const snap = await getCurrentStatus();
    expect(snap.source).toBe("live");
    expect(snap.overall).toBe("operational");
    expect(snap.components).toHaveLength(6);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("returns memory on a second call within the fresh TTL (no second fetch)", async () => {
    mockFetchOk(clearPayload);
    const a = await getCurrentStatus();
    const b = await getCurrentStatus();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("falls back to memory and marks source=stale when fetch fails", async () => {
    // First call: success seeds the cache.
    mockFetchOk(clearPayload);
    await getCurrentStatus();
    // Force a refresh that fails.
    mockFetchFail("upstream 503");
    const stale = await forceRefresh();
    expect(stale.source).toBe("stale");
    expect(stale.lastError).toContain("upstream 503");
    expect(stale.overall).toBe("operational"); // last good
  });

  it("returns an empty snapshot when no memory + no disk + fetch fails", async () => {
    mockFetchFail("offline");
    const snap = await getCurrentStatus();
    expect(snap.source).toBe("empty");
    expect(snap.overall).toBe("operational");
    expect(snap.lastError).toContain("offline");
  });

  it("hydrates from disk on cold boot before kicking a network refresh", async () => {
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 10_000 } as Awaited<ReturnType<typeof fsP.stat>>);
    mockReadFile.mockResolvedValue(JSON.stringify(clearPayload));
    mockFetchOk(clearPayload);
    const snap = await getCurrentStatus();
    expect(snap.source).toBe("disk-cache");
    expect(snap.components).toHaveLength(6);
  });

  it("dedupes concurrent callers to a single in-flight fetch", async () => {
    let resolve: ((v: unknown) => void) | null = null;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = (payload: unknown) =>
            r({ ok: true, status: 200, json: async () => payload });
        })
    ) as unknown as typeof fetch;

    const p1 = getCurrentStatus();
    const p2 = getCurrentStatus();
    await Promise.resolve();
    expect(resolve).not.toBeNull();
    resolve!(clearPayload);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("records change events on incident transitions and exposes them via getChanges(since)", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    // 1st fetch: no incidents
    mockFetchOk(clearPayload);
    await getCurrentStatus();
    expect(getChanges(since)).toEqual([]);

    // 2nd fetch (forced): an incident appears
    mockFetchOk(incidentPayload);
    await forceRefresh();
    const changes = getChanges(since);
    expect(changes).toHaveLength(1);
    expect(changes[0].transition).toBe("new");
    expect(changes[0].incidentId).toBe("yn24rtdnf77b");
  });

  it("does not emit change events for unchanged refreshes", async () => {
    mockFetchOk(incidentPayload);
    await getCurrentStatus();
    const since = new Date(Date.now() + 1000).toISOString(); // future cutoff
    mockFetchOk(incidentPayload);
    await forceRefresh();
    expect(getChanges(new Date(0).toISOString()).length).toBe(1); // only the initial "new"
    expect(getChanges(since)).toEqual([]); // no diff on the second refresh
  });

  it("getChanges returns [] for an invalid since timestamp", () => {
    expect(getChanges("not-a-date")).toEqual([]);
  });
});
