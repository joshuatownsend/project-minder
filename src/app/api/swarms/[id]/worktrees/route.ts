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

    const removals = tasks.flatMap((task) => {
      if (task.swarm_role !== "member") return [];
      let meta: { worktreePath?: string; projectPath?: string } = {};
      try { meta = JSON.parse(task.metadata ?? "{}") as typeof meta; } catch { return []; }
      const { worktreePath, projectPath } = meta;
      if (!worktreePath || !projectPath || !existsSync(worktreePath)) return [];
      return [
        execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectPath })
          .catch((err: Error) => { errors.push(`task ${task.id}: ${err.message}`); }),
      ];
    });

    await Promise.allSettled(removals);

    if (errors.length > 0) {
      console.warn("[api/swarms/[id]/worktrees DELETE] partial failures:", errors);
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[api/swarms/[id]/worktrees DELETE]", err);
    return NextResponse.json({ error: "Failed to remove worktrees" }, { status: 500 });
  }
}
