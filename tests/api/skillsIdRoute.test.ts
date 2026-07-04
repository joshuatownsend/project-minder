/**
 * Characterization tests for GET /api/skills/[id]
 *
 * Skills twin of agentsIdRoute.test.ts. Covers:
 *  - Happy path: 200, entry + bodyFull + usage + period + backend header
 *  - Edge: unknown id → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SkillEntry } from "@/lib/indexer/types";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getSkillUsage: vi.fn(),
}));

import { promises as fsMock } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getSkillUsage } from "@/lib/data";
import { GET } from "@/app/api/skills/[id]/route";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: "user:deploy-helper",
    slug: "deploy-helper",
    name: "deploy-helper",
    source: "user",
    filePath: "C:\\Users\\me\\.claude\\skills\\deploy-helper\\SKILL.md",
    bodyExcerpt: "Deploys the app...",
    frontmatter: {},
    mtime: "2026-06-01T00:00:00Z",
    ctime: "2026-06-01T00:00:00Z",
    provenance: { kind: "user-local" },
    kind: "skill",
    layout: "bundled",
    ...overrides,
  };
}

function req(id: string) {
  return new NextRequest(`http://localhost/api/skills/${id}`);
}

describe("GET /api/skills/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the entry, full body text, joined usage, and backend header", async () => {
    const entry = makeSkill();
    vi.mocked(loadCatalog).mockResolvedValue({ agents: [], skills: [entry] });
    vi.mocked(fsMock.readFile).mockResolvedValue("# deploy-helper\n\nFull body text.");
    vi.mocked(getSkillUsage).mockResolvedValue({
      stats: [{ name: "deploy-helper", invocations: 3, projects: {}, sessions: [] }],
      meta: { backend: "file" },
    } as unknown as Awaited<ReturnType<typeof getSkillUsage>>);

    const res = await GET(req("user:deploy-helper"), {
      params: Promise.resolve({ id: "user:deploy-helper" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    const body = await res.json();
    expect(body.entry).toMatchObject({ id: "user:deploy-helper", name: "deploy-helper" });
    expect(body.bodyFull).toBe("# deploy-helper\n\nFull body text.");
    expect(body.usage).toMatchObject({ name: "deploy-helper", invocations: 3 });
    expect(body.period).toBe("all");
  });

  it("returns 404 for an id not present in the catalog", async () => {
    vi.mocked(loadCatalog).mockResolvedValue({ agents: [], skills: [] });

    const res = await GET(req("nonexistent"), {
      params: Promise.resolve({ id: "nonexistent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Not found" });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});
