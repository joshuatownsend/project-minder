import { NextResponse } from "next/server";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { demoMode } from "@/lib/demo/demoMode";
import { demoGithubActivity } from "@/lib/demo/activity";

// Dumb cache reader, mirroring GET /api/git-status. The flag gate + enqueue
// live at the dashboard load site (GET /api/projects); with nothing enqueued
// `getAll()` is {} and the GitHub strip renders nothing — so this route is
// harmless before the enqueue is wired.
export async function GET() {
  if (await demoMode()) {
    const statuses = demoGithubActivity(Date.now());
    return NextResponse.json({ statuses, pending: 0, total: Object.keys(statuses).length });
  }
  return NextResponse.json({
    statuses: githubActivityCache.getAll(), // Record<slug, GithubActivity>
    pending: githubActivityCache.pending,
    total: githubActivityCache.total,
  });
}
