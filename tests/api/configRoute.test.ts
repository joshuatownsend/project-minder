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

import { PATCH } from "@/app/api/config/route";

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:4100/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
