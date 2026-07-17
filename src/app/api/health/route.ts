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
 *   version: string,          // package.json version (baked at boot)
 *   uptimeSec: number,        // process.uptime(), rounded
 *   demoMode: boolean,
 *   db: InitStatus,           // probeInitStatus() — never initDb() directly
 *   bootstrap: { ran, subsystems },
 *   watchers: { gitStatus, githubActivity, manualSteps, dispatcher, disposers }
 * }
 * ```
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

export async function GET(): Promise<NextResponse> {
  // Independent lookups — run concurrently; this route is polled every ~15s
  // by the Settings page (and by the tray app in C1) and must stay fast.
  const [initStatus, demo] = await Promise.all([
    probeInitStatus(),
    demoMode().catch(() => false),
  ]);
  const ok = initStatus.state === "success";

  return NextResponse.json(
    {
      ok,
      status: ok ? "ok" : "degraded",
      version: appVersion(),
      uptimeSec: Math.round(process.uptime()),
      demoMode: demo,
      db: initStatus,
      bootstrap: getBootstrapStatus(),
      watchers: collectWatchers(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
