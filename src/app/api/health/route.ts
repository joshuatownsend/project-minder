import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";
import { probeInitStatus } from "@/lib/data";
import { demoMode } from "@/lib/demo/demoMode";
import { getBootstrapStatus } from "@/lib/bootstrap";
import { registeredDisposerCount } from "@/lib/lifecycle";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { githubActivityCache } from "@/lib/githubActivityCache";
import { manualStepsWatcher } from "@/lib/manualStepsWatcher";
import { isDispatcherRunning } from "@/lib/tasks/dispatcher";
import { resolveServerRoot } from "@/lib/serverRoot";
import { sampleMemory } from "@/lib/memoryMonitor";
import { getWorkerStatus } from "@/lib/db/workerHost";
import { getWatcherStatus } from "@/lib/db/ingestWatcher";
import type { HealthIngest, HealthResponse } from "@/lib/types/init";

/**
 * GET /api/health — liveness + readiness probe.
 *
 * This is the stable contract the tray app (Phase C1) polls every ~15s to show
 * up/degraded/down, and it is what the pre-existing Home banner + Settings
 * DB-status row already consume. It MUST stay fast (<100ms), dependency-free
 * (no project scan, no network, no `gh`/`git` subprocess) and shape-stable.
 *
 * Response body:
 * ```
 * {
 *   ok: boolean,              // legacy field: true ONLY when db.state === "success"
 *   status: "ok" | "degraded",// process is up; "degraded" mirrors !ok
 *   version: string,          // package.json version (read once on first request, then cached)
 *   uptimeSec: number,        // process.uptime(), rounded
 *   demoMode: boolean,
 *   db: InitStatus,           // probeInitStatus() — never initDb() directly
 *   bootstrap: { ran, subsystems },
 *   watchers: { gitStatus, githubActivity, manualSteps, dispatcher, disposers },
 *   memory: { rssMb, heapTotalMb, heapUsedMb, externalMb, arrayBuffersMb, worker },  // #561
 *   ingest: { mode, watcherMode, initialReconcileMs, eventsHandled, crashesLastHour } // #558
 * }
 * ```
 *
 * `memory` and `ingest` are in-memory reads too: `process.memoryUsage()` plus
 * cached state the ingest worker last reported. The tray reads `memory.rssMb`
 * for its restart-above-threshold guard, so this route is the one place that
 * number must keep coming from.
 *
 * HTTP status preserves the original contract established in PR #148: 200 when
 * the DB state machine has reached `success`, 503 for every other state
 * (idle / in-flight / transient-failed / permanent-failed). Both carry the
 * full body — external consumers (Home page, Settings, the tray) read the body
 * regardless of status code. `probeInitStatus()` actively drives the state
 * machine forward (idempotent on success / within-TTL failure) so a monitor
 * never sees a misleading result on a never-probed `idle` state.
 */

export const dynamic = "force-dynamic";

// App version, resolved lazily from package.json and cached for the process.
// Read at runtime (not a static import of the root JSON) so the file stays
// out of this route's module graph; resolveServerRoot() carries the
// turbopackIgnore annotation that keeps the read out of Node File Tracing,
// and points at package.json in dev/start and in the packaged sidecar alike.
// Never throws.
let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(path.join(resolveServerRoot(), "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof v === "string" ? v : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

// All five accessors are O(1) in-memory reads (Map.size / boolean flags)
// that structurally cannot throw — no defensive wrapping needed.
function collectWatchers(): Record<string, number | boolean> {
  return {
    gitStatus: gitStatusCache.total,
    githubActivity: githubActivityCache.total,
    manualSteps: manualStepsWatcher.watchedCount,
    dispatcher: isDispatcherRunning(),
    disposers: registeredDisposerCount(),
  };
}

/**
 * Which ingest pipeline is live and how it hears about JSONL changes (#558).
 * All O(1) in-memory reads: the worker host caches what the worker last
 * reported, and the in-process watcher exposes its own snapshot. `mode` is
 * derived from what is actually running rather than from the env flags, so a
 * worker that crashed out and handed off to the in-process watcher reports
 * the truth.
 */
function collectIngest(): HealthIngest {
  const worker = getWorkerStatus();
  if (worker.running) {
    return {
      mode: "worker",
      watcherMode: worker.watcher?.watcherMode ?? null,
      initialReconcileMs: worker.watcher?.initialReconcileMs ?? null,
      eventsHandled: worker.watcher?.eventsHandled ?? 0,
      crashesLastHour: worker.crashesLastHour,
    };
  }
  const inProcess = getWatcherStatus();
  return {
    mode: inProcess.running ? "in-process" : "off",
    watcherMode: inProcess.running ? inProcess.watcherMode : null,
    initialReconcileMs: inProcess.initialReconcileMs,
    eventsHandled: inProcess.eventsHandled,
    crashesLastHour: worker.crashesLastHour,
  };
}

export async function GET(): Promise<NextResponse> {
  // Independent lookups — run concurrently; this route is polled every ~15s
  // by the Settings page (and by the tray app in C1) and must stay fast.
  const [initStatus, demo] = await Promise.all([
    probeInitStatus(),
    demoMode().catch(() => false),
  ]);
  const ok = initStatus.state === "success";

  // Annotated with the shared `HealthResponse` so this route is the enforced
  // producer of the contract documented above: dropping or renaming a field
  // fails the build here, rather than arriving `undefined` at the tray, the
  // Home banner, and Settings.
  const body: HealthResponse = {
    ok,
    status: ok ? "ok" : "degraded",
    version: appVersion(),
    uptimeSec: Math.round(process.uptime()),
    demoMode: demo,
    db: initStatus,
    bootstrap: getBootstrapStatus(),
    watchers: collectWatchers(),
    memory: sampleMemory(),
    ingest: collectIngest(),
  };

  return NextResponse.json(
    body,
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
