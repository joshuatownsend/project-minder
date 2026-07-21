import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCachedScan } from "@/lib/cache";
import { checkWorktreeStatus, checkAllWorktreeStatuses } from "@/lib/worktreeChecker";
import { worktreeSlug } from "@/lib/worktreeUtils";
import { processManager, findFreePort } from "@/lib/processManager";
import { checkWslRoot, parseWslUncPath } from "@/lib/wsl";

const execFileAsync = promisify(execFile);

/** Never-wake preflight: git probes / process spawns against a stopped WSL
 *  distro's \\wsl.localhost paths would auto-start its VM. Returns the check
 *  only when the path is WSL and NOT reachable; null means "go ahead". */
async function wslBlocked(...paths: string[]) {
  for (const p of paths) {
    if (!parseWslUncPath(p)) continue;
    const check = await checkWslRoot(p);
    if (check && !check.ok) return check;
  }
  return null;
}

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

  // Stopped-WSL project (carried forward): no statuses this cycle rather
  // than a git probe that would wake the VM.
  if (await wslBlocked(project.path)) return NextResponse.json([]);

  const statuses = await checkAllWorktreeStatuses(project.path, project.worktrees);
  return NextResponse.json(statuses);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
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

  // Every filesystem operation below uses `wt.worktreePath` — the value the
  // SCANNER discovered — rather than `body.worktreePath`, which came from the
  // request. The two are equal here by the check above, so this is not a
  // behaviour change; it means the paths handed to git and the process manager
  // provably originate from the scan result instead of being request data that
  // happens to have passed a guard four lines earlier. That is what makes the
  // allowlist visible to a reader (and to CodeQL, which cannot see an equality
  // comparison as a sanitizer), and it stays correct if the match above is ever
  // relaxed to compare case-insensitively or on normalized separators, where
  // the two strings could legitimately differ.
  const worktreePath = wt.worktreePath;

  // Both actions touch the filesystem (git probes, dev-server spawn) at the
  // project AND worktree paths — refuse outright while the distro is stopped.
  const blocked = await wslBlocked(project.path, worktreePath);
  if (blocked) {
    return NextResponse.json(
      {
        error: `WSL distro '${blocked.distro}' is not running (${blocked.reason}) — Minder never wakes a stopped distro. Start it and retry.`,
      },
      { status: 503 }
    );
  }

  const wtSlug = worktreeSlug(slug, wt.branch);

  if (body.action === "start-server") {
    const rawPort = body.parentDevPort ?? project.devPort ?? 3000;
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65534) {
      return NextResponse.json({ error: "Invalid parentDevPort" }, { status: 400 });
    }
    const startPort = rawPort + 1;
    const port = await findFreePort(startPort);
    if (!port) return NextResponse.json({ error: `No free port from ${startPort}` }, { status: 409 });
    const info = await processManager.start(wtSlug, worktreePath, port);
    return NextResponse.json({ ...info, resolvedPort: port });
  }

  if (body.action === "remove") {
    const status = await checkWorktreeStatus(project.path, worktreePath, wt.branch);
    if (!status.isStale) {
      return NextResponse.json({ error: "Worktree is not stale — cannot remove automatically" }, { status: 400 });
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        "git", ["worktree", "remove", worktreePath],
        { cwd: project.path, timeout: 10000 }
      );
      return NextResponse.json({ removed: true, output: stdout || stderr });
    } catch (err: unknown) {
      // execFileAsync error objects carry stdout/stderr — prefer that for actionable git messages
      const gitMsg =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: string }).stderr).trim()
          : "";
      const fallback = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: gitMsg || fallback }, { status: 409 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
