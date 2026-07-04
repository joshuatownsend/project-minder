/**
 * Characterization tests for GET /api/agents/[id]
 *
 * Loads the catalog, finds the matching AgentEntry, reads its file body,
 * joins usage stats via the alias map, and returns everything together.
 * Covers:
 *  - Happy path: 200, entry + bodyFull + usage + period + backend header
 *  - Edge: unknown id → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { AgentEntry } from "@/lib/indexer/types";

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock("@/lib/indexer/catalog", () => ({
  loadCatalog: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getAgentUsage: vi.fn(),
}));

import { promises as fsMock } from "fs";
import { loadCatalog } from "@/lib/indexer/catalog";
import { getAgentUsage } from "@/lib/data";
import { GET } from "@/app/api/agents/[id]/route";

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "user:code-reviewer",
    slug: "code-reviewer",
    name: "code-reviewer",
    source: "user",
    filePath: "C:\\Users\\me\\.claude\\agents\\code-reviewer.md",
    bodyExcerpt: "Reviews code...",
    frontmatter: {},
    mtime: "2026-06-01T00:00:00Z",
    ctime: "2026-06-01T00:00:00Z",
    provenance: { kind: "user-local" },
    kind: "agent",
    ...overrides,
  };
}

function req(id: string, period?: string) {
  const url = new URL(`http://localhost/api/agents/${id}`);
  if (period) url.searchParams.set("period", period);
  return new NextRequest(url.toString());
}

describe("GET /api/agents/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the entry, full body text, joined usage, and backend header", async () => {
    const entry = makeAgent();
    vi.mocked(loadCatalog).mockResolvedValue({ agents: [entry], skills: [] });
    vi.mocked(fsMock.readFile).mockResolvedValue("# code-reviewer\n\nFull body text.");
    vi.mocked(getAgentUsage).mockResolvedValue({
      stats: [{ name: "code-reviewer", invocations: 5, projects: {}, sessions: [] }],
      meta: { backend: "file" },
    } as unknown as Awaited<ReturnType<typeof getAgentUsage>>);

    const res = await GET(req("user:code-reviewer"), {
      params: Promise.resolve({ id: "user:code-reviewer" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Minder-Backend")).toBe("file");
    const body = await res.json();
    expect(body.entry).toMatchObject({ id: "user:code-reviewer", name: "code-reviewer" });
    expect(body.bodyFull).toBe("# code-reviewer\n\nFull body text.");
    expect(body.usage).toMatchObject({ name: "code-reviewer", invocations: 5 });
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

  it("falls back to an empty body string when the file read fails", async () => {
    const entry = makeAgent({ id: "user:missing-file" });
    vi.mocked(loadCatalog).mockResolvedValue({ agents: [entry], skills: [] });
    vi.mocked(fsMock.readFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(getAgentUsage).mockResolvedValue({
      stats: [],
      meta: { backend: "file" },
    } as unknown as Awaited<ReturnType<typeof getAgentUsage>>);

    const res = await GET(req("user:missing-file"), {
      params: Promise.resolve({ id: "user:missing-file" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bodyFull).toBe("");
    expect(body.usage).toBeUndefined();
  });
});
