import { NextResponse } from "next/server";
import {
  getAllSlugsWithBufferedEvents,
  getProjectBackgroundActivity,
} from "@/lib/hooks/buffer";
import { getCachedScan } from "@/lib/cache";

/**
 * T2.3b — portfolio aggregate of recently-observed background tasks +
 * session crons across all projects. Sourced from the in-memory hook
 * ring buffer, so only Stop / SubagentStop events received within
 * `STALE_EVICT_MS` (5 min) are included. Surfaces:
 *
 *   {
 *     projects: [
 *       { slug, projectName, backgroundTasks, sessionCrons, lastObservedAt },
 *       ...
 *     ],
 *     totals: { backgroundTasks: N, sessionCrons: M, projectsWithActivity: K }
 *   }
 *
 * Element shape of `backgroundTasks` / `sessionCrons` is `unknown[]` —
 * the public Claude Code docs don't yet publish the inner shape, so the
 * UI does defensive runtime narrowing.
 */

interface ProjectActivity {
  slug: string;
  projectName: string;
  backgroundTasks: unknown[];
  sessionCrons: unknown[];
  lastObservedAt: number | null;
}

export async function GET() {
  const slugs = getAllSlugsWithBufferedEvents();
  const scan = getCachedScan();
  const projectNameBySlug = new Map<string, string>();
  if (scan) {
    for (const p of scan.projects) {
      projectNameBySlug.set(p.slug, p.name);
    }
  }

  const projects: ProjectActivity[] = [];
  let totalBg = 0;
  let totalCrons = 0;
  let projectsWithActivity = 0;
  for (const slug of slugs) {
    const activity = getProjectBackgroundActivity(slug);
    if (
      activity.backgroundTasks.length === 0 &&
      activity.sessionCrons.length === 0
    ) {
      continue;
    }
    projects.push({
      slug,
      projectName: projectNameBySlug.get(slug) ?? slug,
      backgroundTasks: activity.backgroundTasks,
      sessionCrons: activity.sessionCrons,
      lastObservedAt: activity.lastObservedAt,
    });
    totalBg += activity.backgroundTasks.length;
    totalCrons += activity.sessionCrons.length;
    projectsWithActivity++;
  }
  // Most-recently-observed first.
  projects.sort(
    (a, b) => (b.lastObservedAt ?? 0) - (a.lastObservedAt ?? 0),
  );

  return NextResponse.json({
    projects,
    totals: {
      backgroundTasks: totalBg,
      sessionCrons: totalCrons,
      projectsWithActivity,
    },
  });
}
