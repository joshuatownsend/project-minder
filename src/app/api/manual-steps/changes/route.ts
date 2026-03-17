import { NextRequest, NextResponse } from "next/server";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";

export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get("since");
  if (!since) {
    return NextResponse.json({ error: "since parameter required" }, { status: 400 });
  }

  // Ensure watcher is initialized
  await manualStepsWatcher.init();

  const changes = manualStepsWatcher.getChanges(since);
  return NextResponse.json(changes);
}
