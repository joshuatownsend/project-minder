import { NextRequest, NextResponse } from "next/server";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { scanManualStepsMd, scanManualStepsArchive } from "@/lib/scanner/manualStepsMd";
import { toggleManualStep, ProjectNotFoundError } from "@/lib/server/mutations/manualSteps";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // ?archived=1 reads the companion MANUAL_STEPS.archive.md instead of the active list.
  // Strict "1" match so ?archived=0 / ?archived=false correctly serve the active list.
  const archived = request.nextUrl.searchParams.get("archived") === "1";
  const info = archived
    ? await scanManualStepsArchive(projectPath)
    : await scanManualStepsMd(projectPath);
  return NextResponse.json(info ?? { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const { lineNumber } = await request.json();
  if (typeof lineNumber !== "number") {
    return NextResponse.json({ error: "lineNumber required" }, { status: 400 });
  }

  // Delegates to the same core mutation the `toggleManualStepAction` Server
  // Action calls, so the route and action can never diverge.
  try {
    const updated = await toggleManualStep(slug, lineNumber);
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to toggle step" }, { status: 500 });
  }
}
