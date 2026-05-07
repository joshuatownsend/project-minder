import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ingestMetric, isOtelDbReady } from "@/lib/db/otelIngest";
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
