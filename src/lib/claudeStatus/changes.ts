/**
 * Diff two {@link ClaudeStatusSnapshot}s and emit a list of
 * {@link ClaudeStatusChange}s describing every transition relevant to
 * the UI listener (new incidents, status changes, resolutions).
 *
 * Pure function: deterministic on the inputs, no side effects. The
 * caller owns the ring buffer and the `changedAt` timestamp source.
 */

import type {
  ClaudeStatusChange,
  ClaudeStatusSnapshot,
  StatusIncident,
} from "./types";

/**
 * Compare two snapshots and return the per-incident transitions.
 * `now` is injected for testability; defaults to `new Date()`.
 */
export function diffIncidents(
  previous: ClaudeStatusSnapshot | null,
  next: ClaudeStatusSnapshot,
  now: Date = new Date(),
): ClaudeStatusChange[] {
  const changes: ClaudeStatusChange[] = [];
  const changedAt = now.toISOString();

  const prevById = new Map<string, StatusIncident>();
  for (const inc of previous?.incidents ?? []) prevById.set(inc.id, inc);

  const nextById = new Map<string, StatusIncident>();
  for (const inc of next.incidents) nextById.set(inc.id, inc);

  // 1. Incidents that appear in next but not previous — new active incident.
  // 2. Incidents in both — emit only if status OR impact changed.
  for (const inc of next.incidents) {
    const prev = prevById.get(inc.id);
    if (!prev) {
      changes.push({
        incidentId: inc.id,
        name: inc.name,
        impact: inc.impact,
        status: inc.status,
        transition: "new",
        shortlink: inc.shortlink,
        changedAt,
      });
      continue;
    }
    if (prev.status !== inc.status || prev.impact !== inc.impact) {
      changes.push({
        incidentId: inc.id,
        name: inc.name,
        impact: inc.impact,
        status: inc.status,
        transition: "status-change",
        shortlink: inc.shortlink,
        changedAt,
      });
    }
  }

  // 3. Incidents in previous but not next — resolved (Statuspage drops
  //    resolved incidents from summary.json's `incidents` array). If a
  //    payload ever does include a resolved incident, parser.ts already
  //    filters it from next.incidents, so this branch fires uniformly.
  for (const inc of previous?.incidents ?? []) {
    if (!nextById.has(inc.id)) {
      changes.push({
        incidentId: inc.id,
        name: inc.name,
        impact: inc.impact,
        status: "resolved",
        transition: "resolved",
        shortlink: inc.shortlink,
        changedAt,
      });
    }
  }

  return changes;
}
