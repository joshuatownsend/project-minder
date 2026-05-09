import { NextResponse } from "next/server";
import { getTask } from "@/lib/tasks/store";
import { addDependency, listDependencies, CycleError } from "@/lib/tasks/store";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const taskId = parseId(id);
  if (taskId === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  const task = await getTask(taskId).catch(() => null);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const deps = await listDependencies(taskId);
  return NextResponse.json(deps);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const taskId = parseId(id);
  if (taskId === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawBlockerId = (body as Record<string, unknown>)?.blockerId;
  if (
    typeof body !== "object" ||
    body === null ||
    !Number.isInteger(rawBlockerId) ||
    (rawBlockerId as number) <= 0
  ) {
    return NextResponse.json({ error: "body.blockerId must be a positive integer" }, { status: 400 });
  }
  const blockerId = rawBlockerId as number;

  if (blockerId === taskId) {
    return NextResponse.json({ error: "A task cannot block itself" }, { status: 400 });
  }

  const task = await getTask(taskId).catch(() => null);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const blocker = await getTask(blockerId).catch(() => null);
  if (!blocker) return NextResponse.json({ error: "Blocker task not found" }, { status: 404 });

  try {
    const dep = await addDependency(taskId, blockerId);
    return NextResponse.json(dep, { status: 201 });
  } catch (err) {
    if (err instanceof CycleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
