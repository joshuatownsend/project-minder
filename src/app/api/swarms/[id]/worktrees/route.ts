import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { getSwarmTasks } from "@/lib/tasks/store";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid swarm id" }, { status: 400 });
  }
  try {
    const tasks = await getSwarmTasks(numId);
    const errors: string[] = [];

    for (const task of tasks) {
      if (task.swarm_role !== "member") continue;
      let meta: { worktreePath?: string; projectPath?: string } = {};
      try {
        meta = JSON.parse(task.metadata ?? "{}") as typeof meta;
      } catch {
        continue;
      }
      const { worktreePath, projectPath } = meta;
      if (!worktreePath || !projectPath || !existsSync(worktreePath)) continue;

      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: projectPath,
        });
      } catch (err) {
        errors.push(`task ${task.id}: ${(err as Error).message}`);
      }
    }

    if (errors.length > 0) {
      console.warn("[api/swarms/[id]/worktrees DELETE] partial failures:", errors);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[api/swarms/[id]/worktrees DELETE]", err);
    return NextResponse.json({ error: "Failed to remove worktrees" }, { status: 500 });
  }
}
