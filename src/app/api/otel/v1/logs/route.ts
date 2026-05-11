import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ingestLogBatch, isOtelDbReady } from "@/lib/db/otelIngest";
import { ensureSchemaReady } from "@/lib/data";
import type { OtlpLogRecord, OtlpResource } from "@/lib/db/otelIngest";

// OTLP/HTTP JSON logs receiver.
//
// Claude Code's OTel SDK appends /v1/logs to whatever base endpoint is
// configured.  Wizard sets OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4100/api/otel
// and OTEL_EXPORTER_OTLP_PROTOCOL=http/json, so traffic arrives here.
//
// Per-record try/catch implements the OTLP partial-success contract: one
// malformed record does not drop the rest of the batch.  Response shape
// follows the OTLP spec (exportLogsServiceResponse):
//
//   { partialSuccess: { rejectedLogRecords: N, errorMessage: "..." } }
//
// A 200 with rejectedLogRecords=0 means full success.
// A 200 with rejectedLogRecords>0 means partial success.
// Non-200 means the entire batch was rejected (e.g. DB unavailable).
//
// DB readiness goes through `ensureSchemaReady()` (the data-layer state
// machine) rather than `initDb()` directly. The state machine classifies
// EBUSY/EPERM/SQLITE_BUSY as transient with `[100, 300, 900]ms` backoff
// and caches `transient-failed` for 30s, so a momentary file lock
// returns 503 instead of 500. Previously the route had its own
// `initPromise` cache that bypassed the retry classifier and crashed
// when quarantine raced with the indexer's open handle.
//
// `ensureSchemaReady()` rather than `probeInitStatus()` because the
// latter intentionally short-circuits when `MINDER_USE_DB=0` (the
// read-path file-parse fallback flag), and OTEL is write-side — it
// needs the DB regardless of which read backend is selected. Using
// `probeInitStatus()` here would 503 every OTEL POST under
// `MINDER_USE_DB=0` (Copilot PR #117 P2 finding).

async function ensureReady(): Promise<boolean> {
  if (!isOtelDbReady()) return false;
  const result = await ensureSchemaReady();
  return result.available;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await ensureReady())) {
    return NextResponse.json(
      { error: "OTEL storage not available" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || !("resourceLogs" in body)) {
    return NextResponse.json(
      { error: "Expected {resourceLogs: [...]} envelope" },
      { status: 400 },
    );
  }

  const resourceLogs = (body as { resourceLogs: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) {
    return NextResponse.json(
      { error: "resourceLogs must be an array" },
      { status: 400 },
    );
  }

  let rejected = 0;
  const errors: string[] = [];

  for (const rl of resourceLogs) {
    if (typeof rl !== "object" || rl === null) continue;
    const resource = (rl as { resource?: OtlpResource }).resource;
    const rawSl = (rl as { scopeLogs?: unknown }).scopeLogs;
    const scopeLogs = Array.isArray(rawSl) ? rawSl : [];

    for (const sl of scopeLogs) {
      if (typeof sl !== "object" || sl === null) continue;
      const rawLr = (sl as { logRecords?: unknown }).logRecords;
      const logRecords = Array.isArray(rawLr) ? rawLr : [];

      const { errors: batchErrors } = await ingestLogBatch(logRecords as OtlpLogRecord[], resource);
      rejected += batchErrors.length;
      for (const e of batchErrors) {
        if (errors.length < 5) errors.push(e);
      }
    }
  }

  const partialSuccess =
    rejected > 0
      ? { rejectedLogRecords: rejected, errorMessage: errors.join("; ") }
      : { rejectedLogRecords: 0 };

  return NextResponse.json({ partialSuccess });
}
