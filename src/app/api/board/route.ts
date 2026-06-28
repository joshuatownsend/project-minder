import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { BoardInfo, BoardIssue, BoardEpic } from "@/lib/types";

/** Does an issue pass the active status / keyword filters? */
function issueMatches(
  issue: BoardIssue,
  status: string | null,
  q: string | undefined,
): boolean {
  if (status && issue.status !== status) return false;
  if (q) {
    const hay = `${issue.title} ${issue.labels.join(" ")} ${
      issue.detail ?? ""
    }`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Apply per-issue status/keyword filters to a board. When a filter is active,
 * epics that end up with no matching issues are dropped (so `?status=doing`
 * doesn't surface empty columns); an unfiltered board is returned untouched so
 * its empty epics still render. Returns undefined when nothing survives.
 */
function filterBoard(
  board: BoardInfo,
  status: string | null,
  q: string | undefined,
): BoardInfo | undefined {
  if (!status && !q) return board;

  const epics: BoardEpic[] = board.epics
    .map((e) => ({
      ...e,
      issues: e.issues.filter((i) => issueMatches(i, status, q)),
    }))
    .filter((e) => e.issues.length > 0);
  const inbox = board.inbox.filter((i) => issueMatches(i, status, q));

  const total =
    epics.length +
    epics.reduce((n, e) => n + e.issues.length, 0) +
    inbox.length;
  if (total === 0) return undefined;
  return { epics, inbox, total };
}

interface BoardProjectView {
  slug: string;
  name: string;
  board: BoardInfo;
}

export async function GET(request: NextRequest) {
  const projectFilter = request.nextUrl.searchParams.get("project");
  const statusFilter = request.nextUrl.searchParams.get("status");
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase() || undefined;

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const projects = result.projects
    .filter((p) => p.board && (!projectFilter || p.slug === projectFilter))
    .map((p): BoardProjectView | null => {
      const board = filterBoard(p.board!, statusFilter, q);
      return board ? { slug: p.slug, name: p.name, board } : null;
    })
    .filter((p): p is BoardProjectView => p !== null);

  const totalEpics = projects.reduce((n, p) => n + p.board.epics.length, 0);
  const totalIssues = projects.reduce(
    (n, p) =>
      n +
      p.board.inbox.length +
      p.board.epics.reduce((m, e) => m + e.issues.length, 0),
    0,
  );

  return NextResponse.json({ projects, totalEpics, totalIssues });
}
