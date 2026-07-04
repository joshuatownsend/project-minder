/**
 * Characterization tests for GET /api/board/[slug]
 *
 * Covers the GET path only (POST mutations are out of scope for this test
 * file — see boardWriter's own unit coverage). GET is a fresh (non-cached)
 * read: resolves the slug to a path, then reads either BOARD.md or
 * (?archived=1) BOARD.archive.md.
 *
 * The route module also imports boardWriter/boardDelegation for its POST
 * handler; those are mocked here purely so importing the module doesn't
 * touch the filesystem — they're never exercised by these GET-only tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache", () => ({
  invalidateCache: vi.fn(),
}));

vi.mock("@/lib/projectPath", () => ({
  findProjectPathBySlug: vi.fn(),
}));

vi.mock("@/lib/scanner/boardMd", () => ({
  scanBoardMd: vi.fn(),
  scanBoardArchive: vi.fn(),
}));

vi.mock("@/lib/boardWriter", () => ({
  addIssue: vi.fn(),
  addEpic: vi.fn(),
  setIssueStatus: vi.fn(),
  editIssue: vi.fn(),
  moveIssue: vi.fn(),
  reorderIssue: vi.fn(),
  promoteTodoToBoard: vi.fn(),
  BoardWriteError: class BoardWriteError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("@/lib/tasks/boardDelegation", () => ({
  promoteBoardIssueToTask: vi.fn(),
}));

import { findProjectPathBySlug } from "@/lib/projectPath";
import { scanBoardMd, scanBoardArchive } from "@/lib/scanner/boardMd";
import { GET } from "@/app/api/board/[slug]/route";

function makeRequest(slug: string, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/board/${slug}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new NextRequest(url.toString());
  const params = { params: Promise.resolve({ slug }) };
  return [req, params] as const;
}

const fakeBoard = {
  epics: [{ id: "e-1", title: "Epic One", status: "doing", issues: [] }],
  inbox: [],
  total: 1,
};

describe("GET /api/board/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the live board for a known slug", async () => {
    vi.mocked(findProjectPathBySlug).mockResolvedValue("C:\\dev\\my-app");
    vi.mocked(scanBoardMd).mockResolvedValue(
      fakeBoard as unknown as Awaited<ReturnType<typeof scanBoardMd>>
    );

    const [req, params] = makeRequest("my-app");
    const res = await GET(req, params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ total: 1 });
    expect(scanBoardMd).toHaveBeenCalledWith("C:\\dev\\my-app");
    expect(scanBoardArchive).not.toHaveBeenCalled();
  });

  it("reads BOARD.archive.md when ?archived=1 is set", async () => {
    vi.mocked(findProjectPathBySlug).mockResolvedValue("C:\\dev\\my-app");
    vi.mocked(scanBoardArchive).mockResolvedValue(
      fakeBoard as unknown as Awaited<ReturnType<typeof scanBoardArchive>>
    );

    const [req, params] = makeRequest("my-app", { archived: "1" });
    const res = await GET(req, params);

    expect(res.status).toBe(200);
    expect(scanBoardArchive).toHaveBeenCalledWith("C:\\dev\\my-app");
    expect(scanBoardMd).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown slug", async () => {
    vi.mocked(findProjectPathBySlug).mockResolvedValue(null);

    const [req, params] = makeRequest("nonexistent");
    const res = await GET(req, params);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Project not found" });
    expect(scanBoardMd).not.toHaveBeenCalled();
  });

  it("falls back to the empty shape when the project has no BOARD.md", async () => {
    vi.mocked(findProjectPathBySlug).mockResolvedValue("C:\\dev\\my-app");
    vi.mocked(scanBoardMd).mockResolvedValue(undefined);

    const [req, params] = makeRequest("my-app");
    const res = await GET(req, params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ epics: [], inbox: [], total: 0 });
  });
});
