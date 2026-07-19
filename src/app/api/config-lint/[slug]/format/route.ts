import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { checkFormatting, applyFormatting } from "@/lib/lint/format";
import { wslGuardResponse } from "@/lib/wslRouteGuard";

/** Resolve a project slug to its on-disk path via the scan cache. Resolving
 *  server-side (rather than trusting a client-supplied path) keeps the
 *  mutating formatter pointed only at known, scanned project directories. */
async function findProjectPath(slug: string): Promise<string | null> {
  let result = getCachedScan();
  if (!result) {
    result = await scanAllProjects();
    setCachedScan(result);
  }
  return result.projects.find((p) => p.slug === slug)?.path ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
  const { slug } = await params;
  const projectPath = await findProjectPath(slug);
  if (!projectPath) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Never-wake preflight: check/apply both read (and apply writes) the
  // project's config files.
  const wslResp = await wslGuardResponse(projectPath);
  if (wslResp) return wslResp;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mode } = (body ?? {}) as { mode?: unknown };
  if (mode !== "check" && mode !== "apply") {
    return NextResponse.json(
      { error: 'mode must be "check" or "apply"' },
      { status: 400 },
    );
  }

  try {
    const result =
      mode === "check"
        ? await checkFormatting(projectPath)
        : await applyFormatting(projectPath, { projectSlug: slug });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
