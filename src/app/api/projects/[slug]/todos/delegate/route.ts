import { NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { delegateTodo } from "@/lib/tasks/todoDelegation";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { findProjectPathBySlug } from "@/lib/projectPath";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
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
    // Resolve via the allowlist of scanned projects (not slug-derived path
    // construction), so the slug can never steer a filesystem read.
    const projectPath = await findProjectPathBySlug(slug);
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
