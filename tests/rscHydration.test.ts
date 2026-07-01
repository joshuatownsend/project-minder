import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

// readConfig is mocked so maybeDehydrate's flag gate is controllable. Declared
// before the modules-under-test import it (vi.mock is hoisted).
vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
  getDevRoots: vi.fn(() => ["C:\\dev"]),
}));

import { readConfig } from "@/lib/config";
import { FEATURE_FLAG_META, getFlag } from "@/lib/featureFlags";
import { jsonClone, maybeDehydrate } from "@/lib/server/prefetch";
import {
  sessionsQuery,
  statsQuery,
  usageQuery,
  agentsQuery,
  skillsQuery,
  insightsListQuery,
  commandsQuery,
  templatesQuery,
  manualStepsQuery,
  configQuery,
} from "@/lib/queryOptions";
import { prefetchSessions } from "@/lib/server/queries/sessions";
import { prefetchStats } from "@/lib/server/queries/stats";
import { prefetchUsage } from "@/lib/server/queries/usage";
import { prefetchAgents } from "@/lib/server/queries/agents";
import { prefetchSkills } from "@/lib/server/queries/skills";
import { prefetchInsights } from "@/lib/server/queries/insights";
import { prefetchCommands } from "@/lib/server/queries/commands";
import { prefetchTemplates } from "@/lib/server/queries/templates";
import { prefetchManualSteps } from "@/lib/server/queries/manualSteps";
import { prefetchConfig } from "@/lib/server/queries/config";

const mockReadConfig = readConfig as unknown as Mock;

// ── jsonClone ────────────────────────────────────────────────────────────────
describe("jsonClone", () => {
  it("renders the value byte-identical to a JSON round-trip", () => {
    const input = {
      when: new Date("2026-06-30T12:00:00.000Z"),
      keep: "x",
      drop: undefined,
      nested: { n: 1, list: [1, 2, 3] },
    };
    const out = jsonClone(input) as Record<string, unknown>;
    // Date → ISO string (matches what `await res.json()` yields client-side).
    expect(out.when).toBe("2026-06-30T12:00:00.000Z");
    // `undefined` keys are dropped, exactly as JSON serialization drops them.
    expect("drop" in out).toBe(false);
    expect(out.nested).toEqual({ n: 1, list: [1, 2, 3] });
  });
});

// ── flag default (Settings toggle vs server gate parity) ──────────────────────
describe("rscHydration is opt-in (default off)", () => {
  it("meta marks defaultOn:false so the Settings toggle matches the server gate", () => {
    // Regression guard (PR #240 Codex review): the server gate reads
    // getFlag(..., false), so the Settings UI — which reads
    // getFlag(flags, key, meta.defaultOn ?? true) — must see defaultOn:false or
    // it would render the toggle ON while the feature is actually off.
    const meta = FEATURE_FLAG_META.find((m) => m.key === "rscHydration");
    expect(meta?.defaultOn).toBe(false);
    expect(getFlag({}, "rscHydration", meta?.defaultOn ?? true)).toBe(false);
    // Server gate: absent key resolves off.
    expect(getFlag(undefined, "rscHydration", false)).toBe(false);
  });
});

// ── maybeDehydrate flag gate ──────────────────────────────────────────────────
describe("maybeDehydrate", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns null when the rscHydration flag is off (default)", async () => {
    mockReadConfig.mockResolvedValue({ featureFlags: { rscHydration: false } });
    const state = await maybeDehydrate([
      async (qc) => {
        await qc.prefetchQuery({ queryKey: ["t"], queryFn: async () => ({ ok: true }) });
      },
    ]);
    expect(state).toBeNull();
  });

  it("defaults to off when the flag is unset", async () => {
    mockReadConfig.mockResolvedValue({ featureFlags: {} });
    const state = await maybeDehydrate([
      async (qc) => {
        await qc.prefetchQuery({ queryKey: ["t"], queryFn: async () => ({ ok: true }) });
      },
    ]);
    expect(state).toBeNull();
  });

  it("dehydrates the prefetched queries when the flag is on", async () => {
    mockReadConfig.mockResolvedValue({ featureFlags: { rscHydration: true } });
    const state = await maybeDehydrate([
      async (qc) => {
        await qc.prefetchQuery({ queryKey: ["greeting"], queryFn: async () => "hi" });
      },
    ]);
    expect(state).not.toBeNull();
    const keys = state!.queries.map((q) => JSON.stringify(q.queryKey));
    expect(keys).toContain(JSON.stringify(["greeting"]));
  });
});

// ── queryKey parity ───────────────────────────────────────────────────────────
// The hydration contract: the server prefetch must fill the EXACT cache key the
// client component mounts with, or hydrated data is never read and the page
// still spins + double-fetches. A fake QueryClient captures the key without
// running the (façade-backed) queryFn.
async function capturePrefetchKey(
  prefetch: (qc: QueryClient) => Promise<void>,
): Promise<unknown> {
  let captured: unknown;
  const fakeQc = {
    prefetchQuery: async (opts: { queryKey: unknown }) => {
      captured = opts.queryKey;
    },
  } as unknown as QueryClient;
  await prefetch(fakeQc);
  return captured;
}

describe("prefetch queryKey parity", () => {
  it("prefetchSessions matches the client sessions key", async () => {
    expect(await capturePrefetchKey(prefetchSessions)).toEqual(sessionsQuery().queryKey);
  });
  it("prefetchStats matches the client stats key", async () => {
    expect(await capturePrefetchKey(prefetchStats)).toEqual(statsQuery().queryKey);
  });
  it("prefetchUsage matches the dashboard's default 30d key", async () => {
    expect(await capturePrefetchKey(prefetchUsage)).toEqual(usageQuery("30d").queryKey);
  });
  it("prefetchAgents matches the unfiltered agents key", async () => {
    expect(await capturePrefetchKey(prefetchAgents)).toEqual(agentsQuery().queryKey);
  });
  it("prefetchSkills matches the unfiltered skills key", async () => {
    expect(await capturePrefetchKey(prefetchSkills)).toEqual(skillsQuery().queryKey);
  });
  it("prefetchInsights matches the unfiltered insights list key", async () => {
    expect(await capturePrefetchKey(prefetchInsights)).toEqual(insightsListQuery().queryKey);
  });
  it("prefetchCommands matches the unfiltered commands key", async () => {
    expect(await capturePrefetchKey(prefetchCommands)).toEqual(commandsQuery().queryKey);
  });
  it("prefetchTemplates matches the templates key", async () => {
    expect(await capturePrefetchKey(prefetchTemplates)).toEqual(templatesQuery().queryKey);
  });
  it("prefetchManualSteps matches the manual-steps list key", async () => {
    expect(await capturePrefetchKey(prefetchManualSteps)).toEqual(manualStepsQuery().queryKey);
  });
  it("prefetchConfig matches the per-tab config key for the prefetched type", async () => {
    expect(await capturePrefetchKey((qc) => prefetchConfig(qc, "hooks"))).toEqual(
      configQuery("hooks").queryKey,
    );
  });
});

// ── new queryOptions factories (commands/templates/manual-steps/config) ────────
type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function mockResponse(body: unknown, { ok = true, status = 200 } = {}) {
  fetchMock.mockResolvedValueOnce({ ok, status, json: async () => body } as Response);
}

function runFn<T>(options: { queryFn?: unknown }): Promise<T> {
  const fn = options.queryFn as (ctx: { signal?: AbortSignal }) => Promise<T>;
  return fn({ signal: undefined });
}

describe("queryOptions — new resource factories", () => {
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("key shapes mirror the queryKeys factory", () => {
    expect(commandsQuery().queryKey).toEqual(["commands", null, null, null]);
    expect(commandsQuery("user", "minder", "lint").queryKey).toEqual([
      "commands",
      "user",
      "minder",
      "lint",
    ]);
    expect(templatesQuery().queryKey).toEqual(["templates"]);
    expect(manualStepsQuery().queryKey).toEqual(["manual-steps", "list"]);
    expect(configQuery("hooks").queryKey).toEqual(["config", "hooks", null, null]);
    expect(configQuery("mcp", "minder", "stripe").queryKey).toEqual([
      "config",
      "mcp",
      "minder",
      "stripe",
    ]);
  });

  it("commandsQuery omits the query string when unfiltered", async () => {
    mockResponse([]);
    await runFn(commandsQuery());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/commands");
  });

  it("commandsQuery builds source/project/q params when filtered", async () => {
    mockResponse([]);
    await runFn(commandsQuery("user", "minder", "deploy"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/commands?source=user&project=minder&q=deploy",
    );
  });

  it("templatesQuery fetches /api/templates", async () => {
    mockResponse({ manifests: [], errors: [] });
    await runFn(templatesQuery());
    expect(fetchMock).toHaveBeenCalledWith("/api/templates", { signal: undefined });
  });

  it("manualStepsQuery fetches /api/manual-steps", async () => {
    mockResponse([]);
    await runFn(manualStepsQuery());
    expect(fetchMock).toHaveBeenCalledWith("/api/manual-steps", { signal: undefined });
  });

  it("configQuery passes the catalog type and omits an unset project", async () => {
    mockResponse({ hooks: [], plugins: [], mcp: [], cicd: [], settingsKeys: [] });
    await runFn(configQuery("hooks"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/claude-config?type=hooks");
  });

  it("configQuery appends project + q when given", async () => {
    mockResponse({ hooks: [], plugins: [], mcp: [], cicd: [], settingsKeys: [] });
    await runFn(configQuery("mcp", "minder", "stripe"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/claude-config?type=mcp&project=minder&q=stripe",
    );
  });

  it("a non-OK response throws", async () => {
    mockResponse(null, { ok: false, status: 500 });
    await expect(runFn(commandsQuery())).rejects.toThrow(/500/);
  });
});
