import { NextRequest, NextResponse } from "next/server";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { scanTodoArchive } from "@/lib/scanner/todoMd";
import { firstBlockedWslPath, WslUnavailableError } from "@/lib/wsl";

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

  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Never-wake preflight: reading TODO.archive.md under a stopped WSL distro
  // would auto-start its VM.
  const blocked = await firstBlockedWslPath(projectPath);
  if (blocked) {
    return NextResponse.json(
      { error: new WslUnavailableError(blocked).message },
      { status: 503 }
    );
  }

  const info = await scanTodoArchive(projectPath);
  return NextResponse.json(info ?? { total: 0, completed: 0, pending: 0, items: [] });
}
