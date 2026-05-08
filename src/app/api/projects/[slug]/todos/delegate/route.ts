import { NextResponse } from "next/server";
import { delegateTodo, resolveProjectPath } from "@/lib/tasks/todoDelegation";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { readConfig, getDevRoots } from "@/lib/config";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const { slug } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { lineNumber } = body as { lineNumber?: unknown };

  if (typeof lineNumber !== "number" || !Number.isFinite(lineNumber) || lineNumber < 1) {
    return NextResponse.json({ error: "lineNumber (positive integer) is required" }, { status: 400 });
  }

  try {
    const cfg = await readConfig();
    const devRoots = getDevRoots(cfg);

    const projectPath = await resolveProjectPath(slug, devRoots);
    if (!projectPath) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const todos = await scanTodoMd(projectPath);
    const item = todos?.items.find((i) => i.lineNumber === lineNumber);
    if (!item) {
      return NextResponse.json({ error: "TODO item not found at that line number" }, { status: 404 });
    }
    if (item.completed) {
      return NextResponse.json({ error: "TODO item is already completed" }, { status: 409 });
    }

    const result = await delegateTodo({
      projectSlug: slug,
      lineNumber,
      todoText: item.text,
      projectPath,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("[api/projects/[slug]/todos/delegate POST]", err);
    return NextResponse.json({ error: "Failed to delegate TODO" }, { status: 500 });
  }
}
