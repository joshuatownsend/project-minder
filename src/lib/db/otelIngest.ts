import "server-only";
import { getDb, prepCached, isDriverLoaded } from "./connection";

// OTLP attribute value helper types.  The JSON encoding wraps every value in
// a typed union: {stringValue}, {intValue}, {doubleValue}, {boolValue}.
interface AttrValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: AttrValue;
}

// ─── Public OTLP JSON shapes ──────────────────────────────────────────────

export interface OtlpResource {
  attributes?: OtlpAttribute[];
}

export interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  body?: { stringValue?: string };
  attributes?: OtlpAttribute[];
}

export interface OtlpDataPoint {
  timeUnixNano?: string | number;
  startTimeUnixNano?: string | number;
  asDouble?: number;
  asInt?: string | number;
  attributes?: OtlpAttribute[];
}

export interface OtlpMetric {
  name: string;
  description?: string;
  sum?: {
    dataPoints?: OtlpDataPoint[];
    isMonotonic?: boolean;
  };
  gauge?: {
    dataPoints?: OtlpDataPoint[];
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

// Normalizes an OTLP attribute list into a Map. The same logical attribute can
// arrive in different wire forms across Claude Code versions — e.g. duration_ms
// as `{stringValue: "42"}` on older builds vs `{intValue: "42"}` on newer ones
// (both shapes coexist in tests/fixtures/otlp-logs.json). This function picks a
// JS representation per wire form but does NOT unify them downstream: a string
// wire form serializes back into payload_json as a quoted JSON string, while
// intValue/doubleValue serialize as unquoted JSON numbers. Consumers querying
// numeric attrs MUST coerce — either via SQL `CAST(... AS REAL/INTEGER)` (the
// dominant pattern in otelQueries.ts and agentCostFromOtel.ts) or via JS-side
// `Number(...)` on the returned scalar (see the lastErrors map at the bottom
// of pressure queries). V.1 audit (2026-05-26) confirms every numeric consumer
// in the tree does one or the other.
function attrMap(attrs: OtlpAttribute[] | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!attrs) return m;
  for (const a of attrs) {
    const v = a.value;
    if (v.stringValue !== undefined) m.set(a.key, v.stringValue);
    else if (v.boolValue !== undefined) m.set(a.key, v.boolValue);
    else if (v.intValue !== undefined) m.set(a.key, Number(v.intValue));
    else if (v.doubleValue !== undefined) m.set(a.key, v.doubleValue);
  }
  return m;
}

function nanoToMs(nano: string | number | undefined): number | null {
  if (nano === undefined || nano === null) return null;
  const n = Number(nano);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 1_000_000);
}

function sessionFromResource(resource: OtlpResource | undefined): string | null {
  const attrs = attrMap(resource?.attributes);
  const s = attrs.get("session.id");
  return typeof s === "string" && s.length > 0 ? s : null;
}

// ─── Log record ingest ────────────────────────────────────────────────────

/**
 * Persist a single OTLP log record to `otel_events`.
 *
 * Throws on hard failures (DB not available, schema bug) — the caller wraps
 * per-record calls in a try/catch to implement partial-success semantics.
 */
export async function ingestLog(
  record: OtlpLogRecord,
  resource: OtlpResource | undefined,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const ts = nanoToMs(record.timeUnixNano ?? record.observedTimeUnixNano);
  if (ts === null) throw new Error("Missing or invalid timeUnixNano");

  const attrs = attrMap(record.attributes);
  const eventName =
    (attrs.get("event.name") as string | undefined) ??
    record.body?.stringValue ??
    "unknown";

  const sessionId = (attrs.get("session.id") as string | undefined) ?? sessionFromResource(resource);

  const payloadAttrs: Record<string, unknown> = {};
  for (const [k, v] of attrs) payloadAttrs[k] = v;

  const payloadJson = JSON.stringify({ ts, body: record.body?.stringValue, attrs: payloadAttrs });

  prepCached(
    db,
    `INSERT INTO otel_events (ts, session_id, event_name, payload_json)
     VALUES (?, ?, ?, ?)`,
  ).run(new Date(ts).toISOString(), sessionId, eventName, payloadJson);
}

// ─── Metric data point ingest ─────────────────────────────────────────────

/**
 * Persist a single OTLP metric (all its data points) to `otel_metrics`.
 *
 * Wrapped in a transaction so either all data points for a metric write or
 * none do on error.  Throws on hard failure.
 */
export async function ingestMetric(
  metric: OtlpMetric,
  resource: OtlpResource | undefined,
): Promise<{ rejected: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const metricName = metric.name;
  if (!metricName) throw new Error("Metric missing name");

  if (metric.sum && metric.gauge) throw new Error(`Metric ${metricName} has both sum and gauge — invalid OTLP shape`);
  const dataPoints: OtlpDataPoint[] = metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? [];
  if (dataPoints.length === 0) return { rejected: 0 };

  const metricType: "counter" | "gauge" = metric.gauge ? "gauge" : "counter";
  const defaultSessionId = sessionFromResource(resource);

  const insertStmt = prepCached(
    db,
    `INSERT INTO otel_metrics (ts, session_id, metric_name, metric_type, value, model, attrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let rejected = 0;
  db.transaction(() => {
    for (const dp of dataPoints) {
      const ts = nanoToMs(dp.timeUnixNano);
      if (ts === null) { rejected++; continue; }

      const attrs = attrMap(dp.attributes);
      const sessionId = (attrs.get("session.id") as string | undefined) ?? defaultSessionId;
      const model = (attrs.get("model") as string | undefined) ?? null;

      const value =
        dp.asDouble !== undefined
          ? dp.asDouble
          : dp.asInt !== undefined
          ? Number(dp.asInt)
          : null;
      if (value === null || !Number.isFinite(value)) { rejected++; continue; }

      const residual: Record<string, unknown> = {};
      for (const [k, v] of attrs) {
        if (k !== "session.id" && k !== "model") residual[k] = v;
      }
      const attrsJson = Object.keys(residual).length ? JSON.stringify(residual) : null;

      insertStmt.run(ts, sessionId, metricName, metricType, value, model, attrsJson);
    }
  })();
  return { rejected };
}

// ─── Batch log ingest ─────────────────────────────────────────────────────

/**
 * Persist a batch of OTLP log records to `otel_events` in a single transaction.
 *
 * Validates each record independently and collects errors; valid records are
 * committed together (one fsync per batch instead of one per record).  Returns
 * the per-record error messages so the route can build a partial-success response.
 */
export async function ingestLogBatch(
  records: OtlpLogRecord[],
  resource: OtlpResource | undefined,
): Promise<{ errors: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const defaultSessionId = sessionFromResource(resource);
  const stmt = prepCached(
    db,
    `INSERT INTO otel_events (ts, session_id, event_name, payload_json)
     VALUES (?, ?, ?, ?)`,
  );

  const rows: [string, string | null, string, string][] = [];
  const errors: string[] = [];

  for (const record of records) {
    try {
      const ts = nanoToMs(record.timeUnixNano ?? record.observedTimeUnixNano);
      if (ts === null) throw new Error("Missing or invalid timeUnixNano");

      const attrs = attrMap(record.attributes);
      const eventName =
        (attrs.get("event.name") as string | undefined) ??
        record.body?.stringValue ??
        "unknown";
      const sessionId = (attrs.get("session.id") as string | undefined) ?? defaultSessionId;

      const payloadAttrs: Record<string, unknown> = {};
      for (const [k, v] of attrs) payloadAttrs[k] = v;
      const payloadJson = JSON.stringify({ ts, body: record.body?.stringValue, attrs: payloadAttrs });

      rows.push([new Date(ts).toISOString(), sessionId, eventName, payloadJson]);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (rows.length > 0) {
    db.transaction(() => {
      for (const row of rows) stmt.run(...row);
    })();
  }

  return { errors };
}

// ─── Guard helper ─────────────────────────────────────────────────────────

export function isOtelDbReady(): boolean {
  return isDriverLoaded();
}
