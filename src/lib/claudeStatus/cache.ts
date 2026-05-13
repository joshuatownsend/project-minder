/**
 * Cache singleton for the Claude Status snapshot.
 *
 * Pattern combines two existing in-repo idioms:
 *   - `src/lib/usage/costCalculator.ts`: file cache + promise singleton +
 *     fallback to a safe default when fetch fails.
 *   - `src/lib/manualStepsWatcher.ts`: `globalThis`-pinned instance so
 *     hot reload in dev doesn't spawn a second copy, plus a 5-minute
 *     ring buffer of change events exposed via `getChanges(since)`.
 *
 * Lifecycle: lazy. `getCurrentStatus()` triggers a fetch only when the
 * in-memory snapshot is older than `FRESH_TTL_MS`. There is no
 * `setInterval` loop; the dashboard's own 60s client poll is what kicks
 * the cycle. This means an idle/unmounted dashboard makes zero network
 * calls — matching the spirit of `gitStatusCache`'s "enqueued by the
 * request" model.
 *
 * On fetch failure we serve the last good snapshot (memory or disk) and
 * mark `source: "stale"`. Backoff doubles up to 8 minutes on consecutive
 * failures so a 4xx/5xx upstream doesn't trigger a hot retry storm.
 */

import { promises as fs } from "fs";
import path from "path";

import { parseSummary } from "./parser";
import { diffIncidents } from "./changes";
import { emptySnapshot } from "./types";
import type { ClaudeStatusChange, ClaudeStatusSnapshot } from "./types";

const SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";
const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "claude-status.json");

const FRESH_TTL_MS = 30_000;            // memory considered fresh under 30s
const STALE_MAX_MS = 30 * 60_000;       // serve stale up to 30min after last good
const FETCH_TIMEOUT_MS = 5_000;         // upstream fetch deadline
const CHANGE_RETENTION_MS = 30 * 60_000; // 30min ring of change events
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 8 * 60_000;

interface CacheState {
  snapshot: ClaudeStatusSnapshot | null;
  inflight: Promise<ClaudeStatusSnapshot> | null;
  changes: ClaudeStatusChange[];
  consecutiveFailures: number;
  nextRetryAt: number;
  diskHydrationAttempted: boolean;
}

function freshState(): CacheState {
  return {
    snapshot: null,
    inflight: null,
    changes: [],
    consecutiveFailures: 0,
    nextRetryAt: 0,
    diskHydrationAttempted: false,
  };
}

// `globalThis` singleton so Next.js dev's HMR doesn't spawn duplicates.
const g = globalThis as unknown as { __claudeStatusCache?: CacheState };
function state(): CacheState {
  if (!g.__claudeStatusCache) g.__claudeStatusCache = freshState();
  return g.__claudeStatusCache;
}

function backoffDelay(failures: number): number {
  if (failures <= 0) return 0;
  const ms = BACKOFF_BASE_MS * 2 ** (failures - 1);
  return Math.min(ms, BACKOFF_MAX_MS);
}

async function readDiskCache(): Promise<ClaudeStatusSnapshot | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as unknown;
    const parsed = parseSummary(data);
    const stat = await fs.stat(CACHE_FILE).catch(() => null);
    return {
      ...parsed,
      source: "disk-cache",
      fetchedAt: stat?.mtimeMs ?? Date.now(),
    };
  } catch {
    return null;
  }
}

async function writeDiskCache(raw: unknown): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
    // Non-critical — the in-memory snapshot still works.
  }
}

async function fetchSummary(): Promise<{ raw: unknown; parsed: ClaudeStatusSnapshot }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SUMMARY_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`status.claude.com fetch failed: HTTP ${res.status}`);
    const raw = (await res.json()) as unknown;
    const parsed = parseSummary(raw);
    return { raw, parsed };
  } finally {
    clearTimeout(timer);
  }
}

function pruneChanges(s: CacheState, now: number): void {
  const cutoff = now - CHANGE_RETENTION_MS;
  s.changes = s.changes.filter((c) => new Date(c.changedAt).getTime() > cutoff);
}

async function refreshSnapshot(): Promise<ClaudeStatusSnapshot> {
  const s = state();
  const now = Date.now();

  // If we're inside the backoff window, don't even try the network —
  // just return whatever we have (or empty) marked as stale.
  if (s.consecutiveFailures > 0 && now < s.nextRetryAt) {
    if (s.snapshot) return { ...s.snapshot, source: "stale" };
    const empty = emptySnapshot(`Backoff: skipping fetch until ${new Date(s.nextRetryAt).toISOString()}`);
    return empty;
  }

  try {
    const { raw, parsed } = await fetchSummary();
    const stamped: ClaudeStatusSnapshot = {
      ...parsed,
      source: "live",
      fetchedAt: now,
      lastError: null,
    };
    const newChanges = diffIncidents(s.snapshot, stamped, new Date(now));
    if (newChanges.length > 0) {
      s.changes.push(...newChanges);
      pruneChanges(s, now);
    }
    s.snapshot = stamped;
    s.consecutiveFailures = 0;
    s.nextRetryAt = 0;
    // Fire-and-forget — caller doesn't wait on disk I/O.
    void writeDiskCache(raw);
    return stamped;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // First-failure-of-streak log; spare the logs on repeated failures.
    if (s.consecutiveFailures === 0) {
      console.warn("[claudeStatus] fetch failed:", msg);
    }
    s.consecutiveFailures += 1;
    s.nextRetryAt = now + backoffDelay(s.consecutiveFailures);

    if (s.snapshot && now - s.snapshot.fetchedAt < STALE_MAX_MS) {
      return { ...s.snapshot, source: "stale", lastError: msg };
    }

    // Try disk cache once if we haven't already (cold boot path).
    if (!s.diskHydrationAttempted) {
      s.diskHydrationAttempted = true;
      const disk = await readDiskCache();
      if (disk) {
        s.snapshot = disk;
        return { ...disk, source: "stale", lastError: msg };
      }
    }

    return emptySnapshot(msg);
  }
}

/**
 * Returns the current snapshot. Triggers an upstream fetch only when
 * in-memory state is older than {@link FRESH_TTL_MS}. Concurrent calls
 * share a single in-flight promise.
 */
export async function getCurrentStatus(): Promise<ClaudeStatusSnapshot> {
  const s = state();
  const now = Date.now();

  if (s.snapshot && now - s.snapshot.fetchedAt < FRESH_TTL_MS) {
    return s.snapshot;
  }

  // Cold boot: prefer a disk seed to a 5-second wait on first request.
  if (!s.snapshot && !s.diskHydrationAttempted) {
    s.diskHydrationAttempted = true;
    const disk = await readDiskCache();
    if (disk) {
      s.snapshot = disk;
      // Kick a background refresh — the caller already has data to render.
      if (!s.inflight) {
        s.inflight = refreshSnapshot().finally(() => { s.inflight = null; });
      }
      return disk;
    }
  }

  if (s.inflight) return s.inflight;
  s.inflight = refreshSnapshot().finally(() => { s.inflight = null; });
  return s.inflight;
}

/**
 * Force an immediate fetch, bypassing TTL. Used by tests and admin actions.
 */
export async function forceRefresh(): Promise<ClaudeStatusSnapshot> {
  const s = state();
  if (s.inflight) return s.inflight;
  s.inflight = refreshSnapshot().finally(() => { s.inflight = null; });
  return s.inflight;
}

/**
 * Return change events since the given ISO timestamp. Mirrors the
 * contract of {@link manualStepsWatcher}.getChanges(since).
 */
export function getChanges(since: string): ClaudeStatusChange[] {
  const s = state();
  const sinceTime = new Date(since).getTime();
  if (Number.isNaN(sinceTime)) return [];
  return s.changes.filter((c) => new Date(c.changedAt).getTime() > sinceTime);
}

/** Test-only reset hook. */
export function _resetForTesting(): void {
  delete g.__claudeStatusCache;
}
