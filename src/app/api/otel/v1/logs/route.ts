import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ingestLog, isOtelDbReady } from "@/lib/db/otelIngest";
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOtelDbReady()) {
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
    const scopeLogs = (rl as { scopeLogs?: unknown[] }).scopeLogs ?? [];

    for (const sl of scopeLogs) {
      if (typeof sl !== "object" || sl === null) continue;
      const logRecords = (sl as { logRecords?: unknown[] }).logRecords ?? [];

      for (const lr of logRecords) {
        try {
          await ingestLog(lr as OtlpLogRecord, resource);
        } catch (err) {
          rejected++;
          errors.push((err as Error).message);
        }
      }
    }
  }

  const partialSuccess =
    rejected > 0
      ? { rejectedLogRecords: rejected, errorMessage: errors.slice(0, 5).join("; ") }
      : { rejectedLogRecords: 0 };

  return NextResponse.json({ partialSuccess });
}
