import { NextRequest, NextResponse } from "next/server";

// Diagnostic catch-all: log any request that arrives at /api/otel exactly
// (not /v1/logs or /v1/metrics). Helps detect path mismatches.
export async function POST(request: NextRequest): Promise<NextResponse> {
  console.log("[otel/BASE] Unexpected POST to /api/otel — path mismatch?", request.url, new Date().toISOString());
  return NextResponse.json({ error: "Use /api/otel/v1/logs or /api/otel/v1/metrics" }, { status: 404 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  console.log("[otel/BASE] GET /api/otel — diagnostic ping", new Date().toISOString());
  return NextResponse.json({ ok: true, endpoint: request.url });
}
