import { NextResponse } from "next/server";
import { getTask, rerunTask } from "@/lib/tasks/store";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  try {
    const existing = await getTask(id);
    if (!existing) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (existing.status !== "failed") {
      return NextResponse.json(
        { error: `Task is '${existing.status}', not 'failed'` },
        { status: 409 }
      );
    }
    const task = await rerunTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    console.error("[api/tasks/[id]/rerun POST]", err);
    return NextResponse.json({ error: "Failed to rerun task" }, { status: 500 });
  }
}
