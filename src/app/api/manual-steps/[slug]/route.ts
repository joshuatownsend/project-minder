import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan, invalidateCache } from "@/lib/cache";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { toggleStepInFile } from "@/lib/manualStepsWriter";

async function findProjectPath(slug: string): Promise<string | null> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  const project = result.projects.find((p) => p.slug === slug);
  return project?.path ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const projectPath = await findProjectPath(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const info = await scanManualStepsMd(projectPath);
  return NextResponse.json(info ?? { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 });
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

  const { lineNumber } = await request.json();
  if (typeof lineNumber !== "number") {
    return NextResponse.json({ error: "lineNumber required" }, { status: 400 });
  }

  const filePath = path.join(projectPath, "MANUAL_STEPS.md");
  try {
    const updated = await toggleStepInFile(filePath, lineNumber);
    invalidateCache();
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Failed to toggle step" }, { status: 500 });
  }
}
