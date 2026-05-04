import { NextResponse } from "next/server";
import { getCachedScan, setCachedScan } from "@/lib/cache";
import { scanAllProjects } from "@/lib/scanner";
import { computeContextBudget } from "@/lib/scanner/contextBudget";

/**
 * Component-model "tokens consumed before your first line of code" estimate
 * for one project. Lazy: not part of the dashboard scan path. Each call
 * recomputes from the current MCP / skill / memory state — cheap because
 * the catalog is cached in-memory.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  let scan = getCachedScan();
  if (!scan) {
    scan = await scanAllProjects();
    setCachedScan(scan);
  }
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: `No project "${slug}".` } },
      { status: 404 }
    );
  }

  const budget = await computeContextBudget(project.path, project.slug);
  return NextResponse.json(budget);
}
