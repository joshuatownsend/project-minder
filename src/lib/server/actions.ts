"use server";

import { toggleManualStep } from "@/lib/server/mutations/manualSteps";
import { setProjectStatus } from "@/lib/server/mutations/projectStatus";
import type { ManualStepsInfo, ProjectStatus } from "@/lib/types";

/**
 * Server Actions for the two live mutations (Performance P3 — PR 4).
 *
 * These are thin `'use server'` wrappers over the plain core mutations in
 * `@/lib/server/mutations/*`. Client components import them directly and call
 * them like async functions; Next.js compiles each to an RPC endpoint, so the
 * write runs in the same server module as the writer — one fewer hand-written
 * route and one fewer client `fetch` hop than the POST/PUT path.
 *
 * Gated client-side behind the default-off `serverActions` flag; when the flag
 * is off, callers keep using the existing `/api/manual-steps/[slug]` +
 * `/api/config` routes (which delegate to the same core mutations), so the two
 * paths are behaviourally identical.
 */

export async function toggleManualStepAction(
  slug: string,
  lineNumber: number,
): Promise<ManualStepsInfo> {
  return toggleManualStep(slug, lineNumber);
}

export async function setProjectStatusAction(
  slug: string,
  status: ProjectStatus,
): Promise<void> {
  return setProjectStatus(slug, status);
}
