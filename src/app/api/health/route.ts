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
// out of this route's module graph; the `turbopackIgnore` on the path keeps
// the fs read out of Node File Tracing so it doesn't over-trace the whole
// project into the standalone bundle. Prefers MINDER_SERVER_ROOT (set by the
// C0 standalone wrapper) then process.cwd() — both hold package.json in
// dev/start and in the packaged sidecar. Never throws.
let cachedVersion: string | null = null;
function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const root = process.env.MINDER_SERVER_ROOT || process.cwd();
  try {
    const raw = readFileSync(path.join(/* turbopackIgnore: true */ root, "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof v === "string" ? v : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

function collectWatchers(): Record<string, number | boolean> {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    gitStatus: safe(() => gitStatusCache.total, 0),
    githubActivity: safe(() => githubActivityCache.total, 0),
    manualSteps: safe(() => manualStepsWatcher.watchedCount, 0),
    dispatcher: safe(() => isDispatcherRunning(), false),
    disposers: safe(() => registeredDisposerCount(), 0),
  };
}

export async function GET(): Promise<NextResponse> {
  const initStatus = await probeInitStatus();
  const ok = initStatus.state === "success";
  const demo = await demoMode().catch(() => false);

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
