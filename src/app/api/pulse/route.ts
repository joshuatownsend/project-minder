import { NextRequest, NextResponse } from "next/server";
import { getCachedScan } from "@/lib/cache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import { getLiveStatusPayload } from "@/lib/liveStatus";

// Single endpoint that bundles every signal the dashboard chrome polls for.
// Replaces three independent client-side intervals (5s + 10s + 30s) with one
// coordinated /api/pulse hit driven by `usePulseContext()`.
//
// Each underlying source already has its own caching layer:
//   - manualStepsWatcher: in-memory ChangeEvent ring (5-minute retention)
//   - getCachedScan(): 5-minute TTL on the project metadata scan
//   - getLiveStatusPayload(): 3-second TTL with single-flight dedup
//
// We don't add another layer here — we just compose. If `since` is omitted we
// skip the changes lookup (initial pulse on mount before there's a baseline).
export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get("since");

  await manualStepsWatcher.init();
  const changes = since ? manualStepsWatcher.getChanges(since) : [];

  // Manual-steps pending count piggybacks on the project scan cache. We never
  // trigger a fresh scan here — if cache is cold we return 0 and let the
  // user's normal /api/projects load warm it up. Avoids a 2.7s scan blocking
  // the every-5s pulse poll.
  const scan = getCachedScan();
  let pendingSteps = 0;
  if (scan) {
    for (const p of scan.projects) {
      if (p.manualSteps?.pendingSteps) pendingSteps += p.manualSteps.pendingSteps;
    }
  }

  // Live status payload — single-flighted, so concurrent /api/status and
  // /api/pulse callers share the same FS sweep within a 3-second window.
  const status = await getLiveStatusPayload();
  const approvalCount = status.sessions.filter((s) => s.status === "approval").length;

  return NextResponse.json({
    pendingSteps,
    approvalCount,
    changes,
    generatedAt: new Date().toISOString(),
  });
}

export type PulsePayload = {
  pendingSteps: number;
  approvalCount: number;
  changes: { slug: string; projectName: string; title: string; changedAt: string }[];
  generatedAt: string;
};
