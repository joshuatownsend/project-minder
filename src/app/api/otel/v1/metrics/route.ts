import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ingestMetric, isOtelDbReady } from "@/lib/db/otelIngest";
import { probeInitStatus } from "@/lib/data";
import type { OtlpMetric, OtlpResource } from "@/lib/db/otelIngest";

// OTLP/HTTP JSON metrics receiver.
//
// Same base-endpoint as the logs receiver — wizard sets
// OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4100/api/otel and the SDK
// appends /v1/metrics.
//
// Implements the same partial-success contract as /v1/logs but for metrics
// (exportMetricsServiceResponse):
//
//   { partialSuccess: { rejectedDataPoints: N, errorMessage: "..." } }
//
// DB readiness goes through `probeInitStatus()` (the data-layer state
// machine) rather than `initDb()` directly. The state machine classifies
// EBUSY/EPERM/SQLITE_BUSY as transient errors with `[100, 300, 900]ms`
// backoff and caches `transient-failed` for 30s, so a momentary file
// lock returns a 503 instead of 500-ing the OTEL endpoint. The earlier
// direct-`initDb()` path raced with the indexer's open and threw EBUSY
// out of the unhandled `await initPromise` (2026-05-11 incident).

async function ensureReady(): Promise<boolean> {
  if (!isOtelDbReady()) return false;
  const status = await probeInitStatus();
  return status.state === "success";
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

  if (typeof body !== "object" || body === null || !("resourceMetrics" in body)) {
    return NextResponse.json(
      { error: "Expected {resourceMetrics: [...]} envelope" },
      { status: 400 },
    );
  }

  const resourceMetrics = (body as { resourceMetrics: unknown }).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) {
    return NextResponse.json(
      { error: "resourceMetrics must be an array" },
      { status: 400 },
    );
  }

  let rejected = 0;
  const errors: string[] = [];

  for (const rm of resourceMetrics) {
    if (typeof rm !== "object" || rm === null) continue;
    const resource = (rm as { resource?: OtlpResource }).resource;
    const raw = (rm as { scopeMetrics?: unknown }).scopeMetrics;
    const scopeMetrics = Array.isArray(raw) ? raw : [];

    for (const sm of scopeMetrics) {
      if (typeof sm !== "object" || sm === null) continue;
      const rawM = (sm as { metrics?: unknown }).metrics;
      const metrics = Array.isArray(rawM) ? rawM : [];

      for (const metric of metrics) {
        try {
          const { rejected: r } = await ingestMetric(metric as OtlpMetric, resource);
          rejected += r;
        } catch (err) {
          rejected++;
          if (errors.length < 5) errors.push((err as Error).message);
        }
      }
    }
  }

  const partialSuccess =
    rejected > 0
      ? { rejectedDataPoints: rejected, errorMessage: errors.join("; ") }
      : { rejectedDataPoints: 0 };

  return NextResponse.json({ partialSuccess });
}
