import { NextRequest, NextResponse } from "next/server";
import { getCachedScan } from "@/lib/cache";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.worktrees || project.worktrees.length === 0) return NextResponse.json([]);

  const worktreeSlugFor = (branch: string) => `${slug}:wt:${branch.replace(/\//g, "-")}`;
  const statuses = await Promise.all(
    project.worktrees.map((wt) =>
      checkWorktreeStatus(project.path, wt.worktreePath, wt.branch, worktreeSlugFor(wt.branch))
    )
  );
  return NextResponse.json(statuses);
}
