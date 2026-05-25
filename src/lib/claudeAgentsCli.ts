import { execFile } from "child_process";

// Live-process feed sourced from `claude agents --json` (v2.1.145+).
// Unlike the JSONL-mtime path in liveStatus.ts, this returns ground-truth
// process identity (PID + alive/not-alive) which kills false-positive
// "working" badges from crashed sessions with recent JSONL files.
//
// The return contract distinguishes:
//   - `[]`     CLI ran successfully; zero live sessions. Apply liveness merge.
//   - `null`   CLI failed (missing binary, timeout, parse error, older version).
//              Skip the liveness merge so the dashboard stays as it was.

const CACHE_TTL_MS = 10_000;
// Negative-result TTL: a transient CLI failure (timeout, ENOENT, parse error)
// caches `null` for only 1 s instead of the full 10 s, so the dashboard recovers
// quickly when the underlying CLI starts working again. Without this, one flaky
// invocation poisons the cache for a full TTL even after the CLI heals.
const CACHE_TTL_NULL_MS = 1_000;
const CLI_TIMEOUT_MS = 5_000;

export interface LiveProcess {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  status: string;
  name?: string;
}

const g = globalThis as unknown as {
  __claudeAgentsCache?: { data: LiveProcess[] | null; cachedAt: number };
  __claudeAgentsFlight?: Promise<LiveProcess[] | null>;
};

function isLiveProcess(v: unknown): v is LiveProcess {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.pid === "number" &&
    typeof o.cwd === "string" &&
    typeof o.kind === "string" &&
    typeof o.startedAt === "number" &&
    // Guard against NaN/Infinity — downstream callers do
    // `new Date(startedAt).toISOString()` which throws RangeError on non-finite.
    Number.isFinite(o.startedAt) &&
    typeof o.sessionId === "string" &&
    typeof o.status === "string" &&
    // `name` is optional but must be a string when present — otherwise a
    // non-string `name` (e.g. number from a buggy CLI build) would flow into
    // `processName: string` and render as `[object Object]` in tooltips.
    (o.name === undefined || typeof o.name === "string")
  );
}

function runClaudeAgentsJson(): Promise<string | null> {
  // Manual Promise wrapper instead of util.promisify — promisify relies on
  // execFile's `util.promisify.custom` symbol to unwrap to {stdout, stderr},
  // and vi.fn() in tests has no such symbol. Manual wrapping behaves the
  // same in production and under mocks. Same pattern as src/lib/worktreeChecker.ts.
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["agents", "--json"],
      { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? null : stdout);
      },
    );
  });
}

async function fetchLiveProcesses(): Promise<LiveProcess[] | null> {
  const stdout = await runClaudeAgentsJson();
  if (stdout === null) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isLiveProcess);
  } catch {
    return null;
  }
}

/**
 * Live Claude Code sessions reported by `claude agents --json`, or `null`
 * if the CLI is unavailable on this machine. Concurrent callers share one
 * in-flight call; results cache for 10 s.
 */
export async function getLiveProcesses(): Promise<LiveProcess[] | null> {
  const cache = g.__claudeAgentsCache;
  if (cache) {
    const ttl = cache.data === null ? CACHE_TTL_NULL_MS : CACHE_TTL_MS;
    if (Date.now() - cache.cachedAt <= ttl) return cache.data;
  }

  if (!g.__claudeAgentsFlight) {
    // Capture the flight Promise locally so the .then/.finally can compare
    // identity against the current `__claudeAgentsFlight` slot. If
    // invalidateClaudeAgentsCache() runs while this flight is still active,
    // the slot is cleared (or replaced) — we skip the cache write so the
    // flight can't repopulate stale data over the invalidation.
    const flight: Promise<LiveProcess[] | null> = fetchLiveProcesses()
      .then((data) => {
        if (g.__claudeAgentsFlight === flight) {
          g.__claudeAgentsCache = { data, cachedAt: Date.now() };
        }
        return data;
      })
      .finally(() => {
        if (g.__claudeAgentsFlight === flight) {
          g.__claudeAgentsFlight = undefined;
        }
      });
    g.__claudeAgentsFlight = flight;
  }
  return g.__claudeAgentsFlight;
}

/** Force-evict the cache. Used by tests and the manual rescan path. */
export function invalidateClaudeAgentsCache(): void {
  delete g.__claudeAgentsCache;
  // Also clear the in-flight Promise so a concurrent fetch resolving AFTER
  // invalidation can't stamp its (pre-invalidation) data back into the cache.
  // Callers already awaiting the prior flight still receive its result via
  // the local Promise reference; they just won't see it leak into the cache.
  delete g.__claudeAgentsFlight;
}
