import { NextResponse } from "next/server";
import { githubActivityCache } from "@/lib/githubActivityCache";

// Dumb cache reader, mirroring GET /api/git-status. The flag gate + enqueue
// live at the dashboard load site (GET /api/projects); with nothing enqueued
// `getAll()` is {} and the GitHub strip renders nothing — so this route is
// harmless before the enqueue is wired.
export async function GET() {
  return NextResponse.json({
    statuses: githubActivityCache.getAll(), // Record<slug, GithubActivity>
    pending: githubActivityCache.pending,
    total: githubActivityCache.total,
  });
}
