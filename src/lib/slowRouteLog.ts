/**
 * Slow-route line for the service log (#559).
 *
 * `/api/usage` was answering in 54–111 s on the live tray server and nothing
 * recorded it: the route has no timing, the tray only sees `/api/health`,
 * and the dashboard just spun. A regression of that size should be one grep
 * away in `minder.log`, so the heavy read routes report any response slower
 * than {@link SLOW_ROUTE_MS}. Fast responses write nothing — the log ring is
 * 5 MB and a line per request would rotate it in hours.
 */

import { serviceLog } from "@/lib/serviceLog";

/** Above this the response is worth a line. Well past "slow", short of "hung". */
export const SLOW_ROUTE_MS = 5_000;

/** Pure: the decision, testable without a clock. */
export function isSlowRoute(elapsedMs: number, thresholdMs: number = SLOW_ROUTE_MS): boolean {
  return elapsedMs >= thresholdMs;
}

/**
 * Call at the end of a route handler with the `Date.now()` taken at its start.
 * `detail` carries whatever identifies the request (period, project, cache
 * hit/miss) — small values only; this is a log line, not a trace.
 */
export function logSlowRoute(
  route: string,
  startedAt: number,
  detail: Record<string, unknown> = {},
  thresholdMs: number = SLOW_ROUTE_MS
): void {
  const elapsedMs = Date.now() - startedAt;
  if (!isSlowRoute(elapsedMs, thresholdMs)) return;
  serviceLog({
    level: "warn",
    subsystem: "route",
    msg: `slow response: ${route} took ${elapsedMs} ms`,
    route,
    elapsedMs,
    ...detail,
  });
}
