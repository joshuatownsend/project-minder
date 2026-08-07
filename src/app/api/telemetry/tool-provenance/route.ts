import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getToolProvenance } from "@/lib/db/otelCorrelation";
import { resolveSinceParam } from "@/lib/telemetryPeriod";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const { since, error } = resolveSinceParam(searchParams);
  if (error !== undefined) {
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    const result = await getToolProvenance({ since: new Date(since).toISOString() });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/tool-provenance]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
