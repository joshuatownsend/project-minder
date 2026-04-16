import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { applySetup, ApplyAction } from "@/lib/setupApply";

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

  const { action } = (body ?? {}) as { action?: unknown };
  if (action !== "claude-md" && action !== "hooks" && action !== "both") {
    return NextResponse.json(
      { error: 'action must be "claude-md", "hooks", or "both"' },
      { status: 400 }
    );
  }

  try {
    const result = await applySetup(projectPath, action as ApplyAction);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
