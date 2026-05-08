import { NextRequest, NextResponse } from "next/server";
import { getCachedScan } from "@/lib/cache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import { getLiveStatusPayload } from "@/lib/liveStatus";
import { sweepAndGetState, drainNewAwaitingTransitions } from "@/lib/hooks/buffer";
import { countOpenDecisions } from "@/lib/tasks/store";
import { getFlag } from "@/lib/featureFlags";
import { readConfig } from "@/lib/config";

// Module-level edge-trigger for decision count. Tracks previous count so the
// "task-decision-required" change event fires only when the count increases.
let prevDecisionCount = 0;

// Single endpoint that bundles every signal the dashboard chrome polls for.
// Replaces three independent client-side intervals (5s + 10s + 30s) with one
// coordinated /api/pulse hit driven by the `usePulse()` hook in
// <PulseProvider />.
//
// Each underlying source already has its own caching layer:
//   - manualStepsWatcher: in-memory ChangeEvent ring (5-minute retention)
//   - getCachedScan(): 5-minute TTL on the project metadata scan
//   - getLiveStatusPayload(): single-flight dedup with TTL ≥ pulse interval
//
// We don't add another layer here — we just compose. If `since` is omitted we
// skip the changes lookup (initial pulse on mount before there's a baseline).
export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get("since");

  await manualStepsWatcher.init();
  const changes = since ? manualStepsWatcher.getChanges(since) : [];

  // Manual-steps pending count: prefer the warm scan cache (one cheap loop
  // over already-loaded project data). When the cache is cold — common right
  // after manualStepsWatcher.invalidateCache() fires on a new entry — fall
  // back to reading the watcher's tracked MANUAL_STEPS.md files directly.
  // That's a handful of small file reads (~50-100 ms) versus a 2.7 s
  // scanAllProjects(); accurate enough that the new-step toast and the badge
  // update on the same pulse cycle.
  let pendingSteps = 0;
  const scan = getCachedScan();
  if (scan) {
    for (const p of scan.projects) {
      if (p.manualSteps?.pendingSteps) pendingSteps += p.manualSteps.pendingSteps;
    }
  } else {
    const pending = await manualStepsWatcher.getAllPendingSteps();
    for (const p of pending) {
      pendingSteps += p.manualSteps.pendingSteps;
    }
  }

  // Live status payload — single-flighted, so concurrent /api/status and
  // /api/pulse callers share the same FS sweep within a 3-second window.
  const status = await getLiveStatusPayload();
  const approvalCount = status.sessions.filter((s) => s.status === "approval").length;

  // Hook-server live activity — stale-sweep is cheap (bounded by session count)
  const { liveSlugs, awaitingSlugs } = sweepAndGetState();

  // Synthesize awaiting-permission change events for edge-triggered toast/sound.
  // drainNewAwaitingTransitions() returns only slugs that entered awaiting since
  // the last poll, so re-polling does not re-fire the toast (level vs. edge).
  const newAwaitingSlugs = since ? drainNewAwaitingTransitions() : [];
  const slugToName = new Map(scan?.projects.map((p) => [p.slug, p.name]) ?? []);
  const awaitingChanges = newAwaitingSlugs.map((slug) => ({
    slug,
    projectName: slugToName.get(slug) ?? slug,
    title: "Claude Code is awaiting permission",
    changedAt: new Date().toISOString(),
    kind: "awaiting-permission" as const,
  }));

  // Task dispatcher signals — only computed when taskDispatcher flag is on
  let decisionCount = 0;
  let dispatcherPaused = false;
  let newDecisionCount = 0;
  try {
    const cfg = await readConfig();
    if (getFlag(cfg.featureFlags, "taskDispatcher")) {
      dispatcherPaused = !!cfg.emergencyStop;
      decisionCount = await countOpenDecisions();
      // Edge-trigger: track previous count in a module-level var so the
      // notification fires exactly once when count increases.
      if (decisionCount > prevDecisionCount) {
        newDecisionCount = decisionCount - prevDecisionCount;
      }
      prevDecisionCount = decisionCount;
    }
  } catch {
    // Non-fatal — dispatch signals are optional
  }

  const generatedAt = new Date().toISOString();

  const decisionChanges = since && newDecisionCount > 0
    ? [{ slug: "", projectName: "", title: `${newDecisionCount} decision${newDecisionCount > 1 ? "s" : ""} waiting`, changedAt: generatedAt, kind: "task-decision-required" as const }]
    : [];

  return NextResponse.json({
    pendingSteps,
    approvalCount,
    decisionCount,
    dispatcherPaused,
    changes: [...changes, ...awaitingChanges, ...decisionChanges],
    liveSlugs,
    awaitingSlugs,
    generatedAt,
  });
}

export type PulsePayload = {
  pendingSteps: number;
  approvalCount: number;
  decisionCount: number;
  dispatcherPaused: boolean;
  changes: { slug: string; projectName: string; title: string; changedAt: string; kind?: string }[];
  liveSlugs: string[];
  awaitingSlugs: string[];
  generatedAt: string;
};
