/**
 * Characterization tests for PATCH /api/config's `port` field.
 *
 * Scoped to the new "Server Port" Settings validation block. Heavy lib
 * boundaries (adapters, efficiencyGradeCache, server/queries/stats,
 * usage/costCalculator) are mocked purely to keep this file from pulling in
 * real fs/scanner work — none of them are exercised by a port-only patch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { MinderConfig } from "@/lib/types";

const BASE_CONFIG: MinderConfig = {
  statuses: {},
  hidden: [],
  portOverrides: {},
  devRoot: "C:\\dev",
};

let stored: MinderConfig = { ...BASE_CONFIG };

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(async () => stored),
  mutateConfig: vi.fn(async (mutator: (c: MinderConfig) => void) => {
    const next = { ...stored };
    mutator(next);
    stored = next;
    return stored;
  }),
}));

vi.mock("@/lib/cache", () => ({ invalidateCache: vi.fn() }));
vi.mock("@/app/api/claude-config/route", () => ({
  invalidateClaudeConfigRouteCache: vi.fn(),
}));
vi.mock("@/lib/server/mutations/projectStatus", () => ({ setProjectStatus: vi.fn() }));
vi.mock("@/lib/usage/costCalculator", () => ({ setPricingRules: vi.fn() }));
vi.mock("@/lib/adapters", () => ({ listAdapters: vi.fn(() => []) }));
vi.mock("@/lib/efficiencyGradeCache", () => ({
  efficiencyGradeCache: { invalidateGrades: vi.fn() },
}));
vi.mock("@/lib/server/queries/stats", () => ({ invalidateClaudeUsageCache: vi.fn() }));
vi.mock("@/lib/memory/seedCategoryCounts", () => ({
  invalidateSessionCategoryCounts: vi.fn(),
}));

import { PATCH } from "@/app/api/config/route";
import { installIsolatedState } from "../_helpers/isolatedState";

/**
 * Isolated because `/api/config` gained a runtime `import()` of the DB layer in
 * #513: a corpus change clears the persisted full-pass verdict, which lives in
 * the database because the reconcile that writes it runs in a worker whose
 * `globalThis` cannot reach the server's.
 *
 * The branch is unreachable for most cases here, but "this test happens not to
 * take that path" is an argument about today's control flow. Isolation does not
 * depend on being right about which branch runs.
 */
installIsolatedState({ prefix: "pm-configroute-" });

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4100/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/config — cache invalidation on a corpus change", () => {
  // Grades and the Claude-usage rollup are computed from the file-parse sweep,
  // so a patch that changes WHICH SESSIONS that sweep returns has to drop them
  // or they describe the previous corpus for the rest of their TTLs.
  //
  // `enabledAdapters` did not qualify until #475 taught `parseAllSessions` to
  // merge non-Claude adapters. Now it changes the corpus exactly the way adding
  // a Claude home does — so a user could enable Codex and go on seeing grades
  // computed without it for five minutes. (Codex P2, PR #490.)
  beforeEach(async () => {
    stored = { ...BASE_CONFIG };
    const adapters = await import("@/lib/adapters");
    vi.mocked(adapters.listAdapters).mockReturnValue([
      { id: "claude" },
      { id: "codex" },
    ] as never);
    const grades = await import("@/lib/efficiencyGradeCache");
    vi.mocked(grades.efficiencyGradeCache.invalidateGrades).mockClear();
    const stats = await import("@/lib/server/queries/stats");
    vi.mocked(stats.invalidateClaudeUsageCache).mockClear();
    const seed = await import("@/lib/memory/seedCategoryCounts");
    vi.mocked(seed.invalidateSessionCategoryCounts).mockClear();
  });

  it("drops the grade and usage caches when enabledAdapters changes", async () => {
    const res = await PATCH(patchRequest({ enabledAdapters: ["claude", "codex"] }));
    expect(res.status).toBe(200);
    expect((await res.json()).config.enabledAdapters).toEqual(["claude", "codex"]);

    const grades = await import("@/lib/efficiencyGradeCache");
    const stats = await import("@/lib/server/queries/stats");
    const seed = await import("@/lib/memory/seedCategoryCounts");
    expect(grades.efficiencyGradeCache.invalidateGrades).toHaveBeenCalled();
    expect(stats.invalidateClaudeUsageCache).toHaveBeenCalled();
    // The one with no TTL, so the only one whose staleness is unbounded.
    expect(seed.invalidateSessionCategoryCounts).toHaveBeenCalled();
  });

  it("leaves them alone for a patch that does not change the corpus", async () => {
    // The counterpart assertion: without it, invalidating unconditionally would
    // also pass, and the caches would exist for nothing.
    const res = await PATCH(patchRequest({ port: 4200 }));
    expect(res.status).toBe(200);

    const grades = await import("@/lib/efficiencyGradeCache");
    const stats = await import("@/lib/server/queries/stats");
    const seed = await import("@/lib/memory/seedCategoryCounts");
    expect(grades.efficiencyGradeCache.invalidateGrades).not.toHaveBeenCalled();
    // Every cache in the block, not just the first. Asserting one of three
    // leaves a regression that invalidates the other two unconditionally
    // passing — which is the same incompleteness this test exists to catch.
    // (Copilot, PR #490.)
    expect(stats.invalidateClaudeUsageCache).not.toHaveBeenCalled();
    expect(seed.invalidateSessionCategoryCounts).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/config — port", () => {
  beforeEach(() => {
    stored = { ...BASE_CONFIG };
  });

  it("accepts a valid port and persists it", async () => {
    const res = await PATCH(patchRequest({ port: 4200 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.port).toBe(4200);
  });

  it("rejects a port below 1024", async () => {
    const res = await PATCH(patchRequest({ port: 1023 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/1024/);
  });

  it("rejects a port above 65535", async () => {
    const res = await PATCH(patchRequest({ port: 65536 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer port", async () => {
    const res = await PATCH(patchRequest({ port: 4100.5 }));
    expect(res.status).toBe(400);
  });

  it("clears the port back to default via null", async () => {
    stored = { ...BASE_CONFIG, port: 4200 };
    const res = await PATCH(patchRequest({ port: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.port).toBeUndefined();
  });
});
