import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanTodoArchive } from "@/lib/scanner/todoMd";

/**
 * GET /api/projects/[slug]/todos/archive
 * Returns the project's archived TODOs (from TODO.archive.md). On-demand only —
 * the scan orchestrator never reads archive files, so this is fetched lazily by
 * the "Archived" disclosure in the TODOs tab.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }

  const project = result.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const info = await scanTodoArchive(project.path);
  return NextResponse.json(info ?? { total: 0, completed: 0, pending: 0, items: [] });
}
