import { NextResponse } from "next/server";
import { getTask, patchTask, deleteTask } from "@/lib/tasks/store";
import { validatePatchTask } from "@/lib/tasks/validation";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  try {
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    console.error("[api/tasks/[id] GET]", err);
    return NextResponse.json({ error: "Failed to fetch task" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  try {
    // Pre-read required: validatePatchTask needs current.status for transition guard.
    const current = await getTask(id);
    if (!current) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json().catch(() => null);
    const validated = validatePatchTask(body, current.status);
    if ("error" in validated) {
      return NextResponse.json(
        { error: validated.error, field: (validated as { field?: string }).field },
        { status: 400 }
      );
    }
    const updated = await patchTask(id, validated);
    if (!updated) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ task: updated });
  } catch (err) {
    console.error("[api/tasks/[id] PATCH]", err);
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  try {
    const deleted = await deleteTask(id);
    if (!deleted) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/tasks/[id] DELETE]", err);
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
