import "server-only";
import path from "path";
import { invalidateCache } from "@/lib/cache";
import { findProjectPathBySlug } from "@/lib/projectPath";
import { toggleStepInFile } from "@/lib/manualStepsWriter";
import { demoMode } from "@/lib/demo/demoMode";
import { demoProjects } from "@/lib/demo/projects";
import type { ManualStepsInfo } from "@/lib/types";

/**
 * Thrown when a slug resolves to no project on disk. Callers map it to a 404
 * (API route) or surface it to the client (Server Action) — distinct from the
 * generic write failure so the two don't collapse into one opaque error.
 */
export class ProjectNotFoundError extends Error {
  constructor(slug: string) {
    super(`No project with slug "${slug}"`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * Core manual-step toggle: resolve the project, flip the `- [ ]`/`- [x]` box on
 * the given line of its MANUAL_STEPS.md, invalidate the scan cache, and return
 * the freshly re-parsed list.
 *
 * Single source of truth for both the POST /api/manual-steps/[slug] route and
 * the `toggleManualStepAction` Server Action, so the two paths can never drift.
 * The underlying `toggleStepInFile` serializes writes per-file via a lock.
 */
export async function toggleManualStep(
  slug: string,
  lineNumber: number,
): Promise<ManualStepsInfo> {
  if (typeof lineNumber !== "number") {
    throw new TypeError("lineNumber must be a number");
  }
  // Demo mode is read-only synthetic data on fake C:\dev paths — never write.
  // No-op the toggle and return the demo project's steps unchanged (the
  // optimistic UI reverts to this on refetch). Covers both the POST route and
  // the toggleManualStepAction Server Action, which both funnel through here.
  if (await demoMode()) {
    const p = demoProjects(Date.now()).find((dp) => dp.slug === slug);
    if (!p) throw new ProjectNotFoundError(slug);
    return p.manualSteps ?? { entries: [], totalSteps: 0, pendingSteps: 0, completedSteps: 0 };
  }
  const projectPath = await findProjectPathBySlug(slug);
  if (!projectPath) throw new ProjectNotFoundError(slug);

  const filePath = path.join(projectPath, "MANUAL_STEPS.md");
  const updated = await toggleStepInFile(filePath, lineNumber);
  invalidateCache();
  return updated;
}
