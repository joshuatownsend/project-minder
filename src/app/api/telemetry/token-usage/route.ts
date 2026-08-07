import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getTokenUsage } from "@/lib/db/otelQueries";
import { resolveSinceParam } from "@/lib/telemetryPeriod";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  // `since` is what the dashboard sends, so the cutoff in the URL is the cutoff
  // used — and the URL changes when the shared toggle's hour bucket advances.
  // While this route resolved `?period=` itself its fetch key never changed, so
  // after an hour boundary it kept serving results from the previous bucket
  // while the `since`-driven cards moved on (Codex review of #402).
  //
  // `period` stays accepted as a fallback: it is the documented shape for
  // hitting these endpoints by hand, and there is no reason to break a saved
  // URL to fix a cache key.
  const { since, error } = resolveSinceParam(searchParams);
  if (error !== undefined) {
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    const result = await getTokenUsage({ since });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/token-usage]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
