/**
 * Pure transform from a raw Statuspage `summary.json` payload to the
 * trimmed {@link ClaudeStatusSnapshot} the UI renders.
 *
 * The function tolerates schema drift: missing optional fields default
 * to safe values, unknown enum values pass through verbatim (the UI has
 * a `default` branch), extra fields are ignored. It never throws.
 */

import type {
  ClaudeStatusSnapshot,
  ComponentStatus,
  IncidentImpact,
  IncidentStatus,
  OverallStatus,
  StatusComponent,
  StatusIncident,
} from "./types";

const LATEST_UPDATE_MAX_CHARS = 280;

type RawSummary = {
  page?: { url?: unknown; updated_at?: unknown };
  components?: unknown;
  incidents?: unknown;
};

type RawComponent = Record<string, unknown>;
type RawIncident = Record<string, unknown>;
type RawIncidentUpdate = Record<string, unknown>;
type RawAffectedComponent = Record<string, unknown>;

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function stripHtml(html: string): string {
  // Statuspage update bodies are plain text in `body` (HTML is only in
  // the atom feed's `content`). We still strip defensively so any
  // sanitization on Statuspage's side that injects tags can't bleed
  // through to a toast.
  return html
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function parseComponent(raw: RawComponent): StatusComponent | null {
  const id = asString(raw["id"]);
  if (!id) return null;
  return {
    id,
    name: asString(raw["name"], id),
    // Unknown statuses pass through — UI default branch handles them.
    status: asString(raw["status"], "operational") as ComponentStatus,
    updatedAt: asString(raw["updated_at"], new Date(0).toISOString()),
  };
}

function parseIncident(raw: RawIncident): StatusIncident | null {
  const id = asString(raw["id"]);
  if (!id) return null;

  // Collect affected component ids from incident_updates[].affected_components[]
  // since the top-level `components` array on an incident isn't always
  // present. Dedup while preserving first-seen order.
  const seen = new Set<string>();
  const affected: string[] = [];
  const updates = asArray<RawIncidentUpdate>(raw["incident_updates"]);
  for (const u of updates) {
    const ac = asArray<RawAffectedComponent>(u["affected_components"]);
    for (const c of ac) {
      const code = asString(c["code"]);
      if (code && !seen.has(code)) {
        seen.add(code);
        affected.push(code);
      }
    }
  }
  // Fallback: some payloads include `components` on the incident itself.
  for (const c of asArray<RawComponent>(raw["components"])) {
    const cid = asString(c["id"]);
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      affected.push(cid);
    }
  }

  // Latest update body — Statuspage orders incident_updates newest-first.
  let latestUpdateBody: string | null = null;
  if (updates.length > 0) {
    const body = asString(updates[0]["body"]);
    if (body) latestUpdateBody = truncate(stripHtml(body), LATEST_UPDATE_MAX_CHARS);
  }

  const fallbackTime = new Date(0).toISOString();
  return {
    id,
    name: asString(raw["name"], "Untitled incident"),
    status: asString(raw["status"], "investigating") as IncidentStatus,
    impact: asString(raw["impact"], "none") as IncidentImpact,
    shortlink: asString(raw["shortlink"], "https://status.claude.com"),
    startedAt: asString(raw["started_at"], fallbackTime),
    updatedAt: asString(raw["updated_at"], fallbackTime),
    resolvedAt: asNullableString(raw["resolved_at"]),
    affectedComponentIds: affected,
    latestUpdateBody,
  };
}

/**
 * Derive the coarse overall status from incidents and component states.
 *
 * Severity priority:
 *  - `incident`   = any active critical incident OR any component in major_outage
 *  - `degraded`   = any active incident (any impact) OR any non-operational component
 *  - `operational`= otherwise
 */
function deriveOverall(
  components: StatusComponent[],
  activeIncidents: StatusIncident[],
): OverallStatus {
  const hasCritical = activeIncidents.some((i) => i.impact === "critical");
  const hasMajorOutage = components.some((c) => c.status === "major_outage");
  if (hasCritical || hasMajorOutage) return "incident";

  if (activeIncidents.length > 0) return "degraded";
  if (components.some((c) => c.status !== "operational")) return "degraded";

  return "operational";
}

/**
 * Parse the Statuspage `summary.json` payload into a {@link ClaudeStatusSnapshot}.
 * Resolved incidents are filtered out so the UI/MCP only see currently-active ones.
 *
 * `source` and `fetchedAt` are stamped by the caller (the cache layer);
 * this function fills them with placeholders so the result is still a
 * valid `ClaudeStatusSnapshot`.
 */
export function parseSummary(payload: unknown): ClaudeStatusSnapshot {
  const raw: RawSummary = (payload && typeof payload === "object" ? (payload as RawSummary) : {});

  const components: StatusComponent[] = [];
  for (const c of asArray<RawComponent>(raw.components)) {
    const parsed = parseComponent(c);
    if (parsed) components.push(parsed);
  }

  const allIncidents: StatusIncident[] = [];
  for (const i of asArray<RawIncident>(raw.incidents)) {
    const parsed = parseIncident(i);
    if (parsed) allIncidents.push(parsed);
  }
  const activeIncidents = allIncidents.filter((i) => i.status !== "resolved");

  const pageUrl = asString(raw.page?.url, "https://status.claude.com");
  const pageUpdated = asString(raw.page?.updated_at, new Date(0).toISOString());

  return {
    page: { url: pageUrl, updatedAt: pageUpdated },
    components,
    incidents: activeIncidents,
    overall: deriveOverall(components, activeIncidents),
    fetchedAt: 0,
    source: "live",
    lastError: null,
  };
}
