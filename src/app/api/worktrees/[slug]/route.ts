import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCachedScan } from "@/lib/cache";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";
import { processManager, findFreePort } from "@/lib/processManager";

const execFileAsync = promisify(execFile);

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = (await req.json()) as {
    action: "start-server" | "remove";
    worktreePath: string;
    parentDevPort?: number;
  };

  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const wt = project.worktrees?.find((w) => w.worktreePath === body.worktreePath);
  if (!wt) return NextResponse.json({ error: "Worktree not found" }, { status: 404 });

  const worktreeSlug = `${slug}:wt:${wt.branch.replace(/\//g, "-")}`;

  if (body.action === "start-server") {
    const startPort = (body.parentDevPort ?? project.devPort ?? 3000) + 1;
    const port = await findFreePort(startPort);
    if (!port) return NextResponse.json({ error: `No free port from ${startPort}` }, { status: 409 });
    const info = await processManager.start(worktreeSlug, body.worktreePath, port);
    return NextResponse.json({ ...info, resolvedPort: port });
  }

  if (body.action === "remove") {
    const status = await checkWorktreeStatus(project.path, body.worktreePath, wt.branch, worktreeSlug);
    if (!status.isStale) {
      return NextResponse.json({ error: "Worktree is not stale — cannot remove automatically" }, { status: 400 });
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        "git", ["worktree", "remove", body.worktreePath],
        { cwd: project.path, timeout: 10000 }
      );
      return NextResponse.json({ removed: true, output: stdout || stderr });
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}