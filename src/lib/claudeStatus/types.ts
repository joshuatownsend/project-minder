/**
 * Types for the Claude Status integration. Mirrors the fields of
 * status.claude.com's Statuspage `summary.json`, trimmed to what the
 * UI/MCP surfaces actually render.
 */

/**
 * Component statuses Statuspage currently emits. The parser is intentionally
 * lenient: it casts any string value from `summary.json` into this type so
 * a Statuspage-side rename or new value doesn't crash the dashboard. Treat
 * a `ComponentStatus` from the snapshot as an opaque string when branching —
 * always provide a `default` arm. UI severity decisions go through
 * `OverallStatus` (a derived 3-value enum), so this leniency is contained.
 */
export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

/**
 * Incident statuses Statuspage currently emits. Same lenient-cast policy
 * as {@link ComponentStatus} — values from the snapshot may be strings
 * outside this union if Statuspage adds new states.
 */
export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export type IncidentImpact = "none" | "minor" | "major" | "critical";

export interface StatusComponent {
  id: string;
  name: string;
  status: ComponentStatus;
  updatedAt: string;
}

export interface StatusIncident {
  id: string;
  name: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  shortlink: string;
  startedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  affectedComponentIds: string[];
  /** Most recent `incident_updates[].body` (HTML stripped to plain text), trimmed to ~280 chars. */
  latestUpdateBody: string | null;
}

/**
 * Cache-state hint. `live` = freshly fetched. `disk-cache` = loaded from
 * disk on cold boot. `stale` = upstream fetch failed and we're serving the
 * last good snapshot. `empty` = no live data and no cache (safe default).
 */
export type SnapshotSource = "live" | "disk-cache" | "stale" | "empty";

export type OverallStatus = "operational" | "degraded" | "incident";

export interface ClaudeStatusSnapshot {
  page: { url: string; updatedAt: string };
  components: StatusComponent[];
  incidents: StatusIncident[];
  overall: OverallStatus;
  fetchedAt: number;
  source: SnapshotSource;
  lastError: string | null;
}

export interface ClaudeStatusChange {
  incidentId: string;
  name: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  transition: "new" | "status-change" | "resolved";
  shortlink: string;
  changedAt: string;
}

/**
 * Safe empty snapshot. Used when no live or cached data is available so
 * the banner can render "operational" instead of crashing.
 */
export function emptySnapshot(lastError: string | null = null): ClaudeStatusSnapshot {
  return {
    page: { url: "https://status.claude.com", updatedAt: new Date(0).toISOString() },
    components: [],
    incidents: [],
    overall: "operational",
    fetchedAt: 0,
    source: "empty",
    lastError,
  };
}
