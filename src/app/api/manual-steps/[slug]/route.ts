import { NextRequest, NextResponse } from "next/server";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { scanManualStepsMd, scanManualStepsArchive } from "@/lib/scanner/manualStepsMd";
import { toggleManualStep, ProjectNotFoundError } from "@/lib/server/mutations/manualSteps";
import { demoMode } from "@/lib/demo/demoMode";
import { demoProjects } from "@/lib/demo/projects";
import { checkWslRoot, parseWslUncPath, WslUnavailableError } from "@/lib/wsl";

const EMPTY_STEPS = { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const archived = request.nextUrl.searchParams.get("archived") === "1";

  // Demo mode: fresh-reads MANUAL_STEPS.md from disk, so guard like the board
  // GET — serve the synthetic steps instead of the fake C:\dev\<slug> path.
  if (await demoMode()) {
    if (archived) return NextResponse.json(EMPTY_STEPS);
    const p = demoProjects(Date.now()).find((dp) => dp.slug === slug);
    return NextResponse.json(p?.manualSteps ?? EMPTY_STEPS);
  }

  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Never-wake preflight for the fresh-read lane: reading MANUAL_STEPS.md
  // under a stopped WSL distro would auto-start its VM.
  if (parseWslUncPath(projectPath)) {
    const check = await checkWslRoot(projectPath);
    if (check && !check.ok) {
      return NextResponse.json(
        { error: new WslUnavailableError(check).message },
        { status: 503 }
      );
    }
  }

  // ?archived=1 reads the companion MANUAL_STEPS.archive.md instead of the active list.
  // Strict "1" match so ?archived=0 / ?archived=false correctly serve the active list.
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
    if (err instanceof WslUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Failed to toggle step" }, { status: 500 });
  }
}
