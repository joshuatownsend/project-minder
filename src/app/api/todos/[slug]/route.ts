import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan, invalidateCache } from "@/lib/cache";
import { appendTodosToFile, toggleTodoInFile, TodoWriteError } from "@/lib/todoWriter";

async function findProjectPath(slug: string): Promise<string | null> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  const project = result.projects.find((p) => p.slug === slug);
  return project?.path ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const projectPath = await findProjectPath(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { text, items } = (body ?? {}) as { text?: unknown; items?: unknown };

  let texts: string[];
  if (Array.isArray(items)) {
    if (!items.every((i) => typeof i === "string")) {
      return NextResponse.json(
        { error: "items must be an array of strings" },
        { status: 400 }
      );
    }
    texts = (items as string[]).filter((s) => s.trim().length > 0);
  } else if (typeof text === "string") {
    texts = [text];
  } else {
    return NextResponse.json(
      { error: "text or items required" },
      { status: 400 }
    );
  }

  if (texts.length === 0) {
    return NextResponse.json(
      { error: "No non-empty items supplied" },
      { status: 400 }
    );
  }

  try {
    const updated = await appendTodosToFile(projectPath, texts);
    invalidateCache();
    return NextResponse.json({ todos: updated, added: texts.length });
  } catch (err) {
    if (err instanceof TodoWriteError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to append TODOs" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const projectPath = await findProjectPath(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lineNumber } = (body ?? {}) as { lineNumber?: unknown };
  if (!Number.isFinite(lineNumber) || !Number.isInteger(lineNumber) || (lineNumber as number) < 1) {
    return NextResponse.json({ error: "lineNumber required" }, { status: 400 });
  }
  const safeLineNumber = lineNumber as number;

  try {
    const updated = await toggleTodoInFile(projectPath, safeLineNumber);
    invalidateCache();
    return NextResponse.json({ todos: updated });
  } catch {
    return NextResponse.json({ error: "Failed to toggle TODO" }, { status: 500 });
  }
}
