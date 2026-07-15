import "server-only";
import type { QueryClient } from "@tanstack/react-query";
import { getSessionsList, type SessionsListResult } from "@/lib/data";
import { readConfig } from "@/lib/config";
import { demoMode } from "@/lib/demo/demoMode";
import type { SessionSummary } from "@/lib/types";
import { queryKeys } from "@/lib/queryKeys";
import { jsonClone } from "@/lib/server/prefetch";

/**
 * Shared session-list loader + filter, used by BOTH `/api/sessions` (the client
 * fetch path) and the RSC prefetch (`prefetchSessions`). Keeping the cache slot
 * and the filter in one place is what guarantees the server-prefetched cache
 * entry is byte-identical to what a client `fetch('/api/sessions')` returns —
 * if the filter logic were duplicated it would silently rot apart and break
 * hydration reuse.
 */

const CACHE_TTL = 30_000; // 30s — kept short so live status badges stay timely

export interface SessionsCacheSlot {
  result: SessionsListResult;
  cachedAt: number;
  // Content-derived watermark: max(endTime, startTime) across the cached
  // session set, captured at refresh time. Feeds the route's ETag so it only
  // rotates when session content actually changes, not on every TTL boundary.
  maxSessionMs: number;
  // Demo state the slot was built under. A single global slot would otherwise
  // serve real sessions after the `demoMode` flag is toggled on (or synthetic
  // after off) until the TTL lapses.
  demo: boolean;
}

// globalThis singleton — survives Next.js module reloads and is shared by the
// route, the RSC prefetch, and `/api/sessions/activity`, so whichever path runs
// first warms the slot for the others.
const globalForSessions = globalThis as unknown as {
  __sessionsCache?: SessionsCacheSlot;
};

export function deriveMaxSessionMs(sessions: SessionSummary[]): number {
  let max = 0;
  for (const s of sessions) {
    const ts = s.endTime ?? s.startTime;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

/** Warm (if stale) and return the shared sessions cache slot. */
export async function getSessionsCacheSlot(): Promise<SessionsCacheSlot> {
  const demo = await demoMode();
  let cache = globalForSessions.__sessionsCache;
  if (!cache || cache.demo !== demo || Date.now() - cache.cachedAt > CACHE_TTL) {
    const result = await getSessionsList();
    cache = {
      result,
      cachedAt: Date.now(),
      maxSessionMs: deriveMaxSessionMs(result.sessions),
      demo,
    };
    globalForSessions.__sessionsCache = cache;
  }
  return cache;
}

export interface SessionFilterOpts {
  enabledAdapters: Set<string>;
  project?: string | null;
  source?: string | null;
  pr?: string | null;
  ticket?: string | null;
}

/** Apply the same filter chain `/api/sessions` applies, in the same order. */
export function filterSessions(
  sessions: SessionSummary[],
  opts: SessionFilterOpts,
): SessionSummary[] {
  let results = sessions.filter((s) => opts.enabledAdapters.has(s.source ?? "claude"));
  if (opts.project) {
    const project = opts.project;
    results = results.filter(
      (s) => s.projectSlug === project || s.projectName.includes(project),
    );
  }
  if (opts.source) {
    results = results.filter((s) => (s.source ?? "claude") === opts.source);
  }
  if (opts.pr) {
    results = results.filter((s) => s.prs?.some((p) => p.url === opts.pr));
  }
  if (opts.ticket) {
    results = results.filter((s) => s.tickets?.some((t) => t.url === opts.ticket));
  }
  return results;
}

/** Resolve the enabled adapter set from config (route + prefetch share this). */
export async function getEnabledAdapters(): Promise<Set<string>> {
  const config = await readConfig();
  const set = new Set(config.enabledAdapters ?? ["claude"]);
  // Demo sessions are all source:"claude"; keep the adapter filter from dropping
  // them when the user has disabled the Claude adapter in Settings.
  if (await demoMode()) set.add("claude");
  return set;
}

/**
 * Prefetch the default session list (`["sessions","list"]`, no filters beyond
 * the enabled-adapter set) — the exact query `SessionsBrowser` mounts with.
 */
export async function prefetchSessions(qc: QueryClient): Promise<void> {
  await qc.prefetchQuery({
    queryKey: queryKeys.sessions.all(),
    queryFn: async (): Promise<SessionSummary[]> => {
      const slot = await getSessionsCacheSlot();
      const enabledAdapters = await getEnabledAdapters();
      return jsonClone(filterSessions(slot.result.sessions, { enabledAdapters }));
    },
  });
}
