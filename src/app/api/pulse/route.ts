import { NextRequest, NextResponse } from "next/server";
import { getCachedScan } from "@/lib/cache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import { getLiveStatusPayload } from "@/lib/liveStatus";
import { sweepAndGetState, drainNewAwaitingTransitions } from "@/lib/hooks/buffer";
import { countOpenDecisions, countInboxMessages, countNewDecisions } from "@/lib/tasks/store";
import { getFlag } from "@/lib/featureFlags";
import { readConfig } from "@/lib/config";

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

  // Live status and config are independent — fetch concurrently.
  // getLiveStatusPayload() is single-flighted so concurrent callers share the same sweep.
  const [status, cfg] = await Promise.all([getLiveStatusPayload(), readConfig()]);
  // Exclude sessions the CLI just confirmed are dead (isLive===false). When
  // the CLI is unavailable or the field is missing (older Claude Code), isLive
  // is undefined and we count the session like before — no regression.
  const approvalCount = status.sessions.filter(
    (s) => s.status === "approval" && s.isLive !== false,
  ).length;

  // Hook-server live activity — stale-sweep is cheap (bounded by session count)
  const { liveSlugs, awaitingSlugs } = sweepAndGetState();

  // CLI-verified liveness from `claude agents --json` (v2.1.145+). When the
  // CLI is unavailable, fall back to the hook-server slugs so consumers that
  // treat "in liveSlugs but NOT in verifiedLiveSlugs" as "stale ring entry"
  // don't false-positive on every card. liveProcessInfo carries PID + name
  // for tooltips on verified-live cards; one entry per slug (first wins,
  // matching the priority sort in getLiveStatusPayload — approval > working).
  const verifiedLiveSet = new Set<string>();
  const liveProcessInfo: Record<string, { pid: number; name?: string }> = {};
  for (const s of status.sessions) {
    if (s.isLive === true && s.pid !== undefined) {
      if (!verifiedLiveSet.has(s.projectSlug)) {
        liveProcessInfo[s.projectSlug] = s.processName
          ? { pid: s.pid, name: s.processName }
          : { pid: s.pid };
      }
      verifiedLiveSet.add(s.projectSlug);
    }
  }
  const verifiedLiveSlugs = status.cliAvailable ? Array.from(verifiedLiveSet) : liveSlugs;

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
  let inboxCount = 0;
  let dispatcherPaused = false;
  let newDecisionCount = 0;
  try {
    if (getFlag(cfg.featureFlags, "taskDispatcher")) {
      dispatcherPaused = !!cfg.emergencyStop;
      // countNewDecisions uses the client-supplied `since` timestamp so each
      // tab gets its own edge-trigger without shared module-level state.
      const sinceEpoch = since ? Math.floor(new Date(since).getTime() / 1000) : NaN;
      const decisionsPromise = countOpenDecisions();
      const inboxPromise = countInboxMessages();
      const newDecisionsPromise = since && Number.isFinite(sinceEpoch)
        ? countNewDecisions(sinceEpoch)
        : Promise.resolve(0);
      [decisionCount, inboxCount, newDecisionCount] = await Promise.all([
        decisionsPromise,
        inboxPromise,
        newDecisionsPromise,
      ]);
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
    inboxCount,
    dispatcherPaused,
    changes: [...changes, ...awaitingChanges, ...decisionChanges],
    liveSlugs,
    awaitingSlugs,
    verifiedLiveSlugs,
    liveProcessInfo,
    cliAvailable: status.cliAvailable,
    generatedAt,
  });
}

export type PulsePayload = {
  pendingSteps: number;
  approvalCount: number;
  decisionCount: number;
  inboxCount: number;
  dispatcherPaused: boolean;
  changes: { slug: string; projectName: string; title: string; changedAt: string; kind?: string }[];
  liveSlugs: string[];
  awaitingSlugs: string[];
  verifiedLiveSlugs: string[];
  liveProcessInfo: Record<string, { pid: number; name?: string }>;
  cliAvailable: boolean;
  generatedAt: string;
};
