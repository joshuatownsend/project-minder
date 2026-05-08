import { NextResponse } from "next/server";
import { listTasks, createTask } from "@/lib/tasks/store";
import { validateCreateTask } from "@/lib/tasks/validation";
import { isTaskStatus, isTaskQuadrant } from "@/lib/tasks/validation";
import type { TaskListFilter } from "@/lib/tasks/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const filter: TaskListFilter = {};

    const statusParam = url.searchParams.get("status");
    if (statusParam) {
      if (!isTaskStatus(statusParam)) {
        return NextResponse.json({ error: `Invalid status filter: ${statusParam}` }, { status: 400 });
      }
      filter.status = statusParam;
    }

    const quadrantParam = url.searchParams.get("quadrant");
    if (quadrantParam) {
      if (!isTaskQuadrant(quadrantParam)) {
        return NextResponse.json({ error: `Invalid quadrant filter: ${quadrantParam}` }, { status: 400 });
      }
      filter.quadrant = quadrantParam;
    }

    const tasks = await listTasks(filter);
    return NextResponse.json({ tasks });
  } catch (err) {
    console.error("[api/tasks GET]", err);
    return NextResponse.json({ error: "Failed to list tasks" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const validated = validateCreateTask(body);
    if ("error" in validated) {
      return NextResponse.json(
        { error: validated.error, field: validated.field },
        { status: 400 }
      );
    }
    const task = await createTask(validated);
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error("[api/tasks POST]", err);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
