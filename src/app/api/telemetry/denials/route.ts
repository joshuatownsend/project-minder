import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getDenialBreakdown } from "@/lib/data/denialAnalyticsFromDb";
import { resolveSinceParam } from "@/lib/telemetryPeriod";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  // Same `since`-first resolution as the other telemetry routes, so this card
  // shares the section's cutoff exactly rather than resolving its own.
  const { since, error } = resolveSinceParam(searchParams);
  if (error !== undefined) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const project = searchParams.get("project") ?? undefined;

  try {
    // `getDenialBreakdown` takes an ISO string; epoch 0 ("all") becomes
    // 1970-01-01, which its `@since IS NULL OR ts >= @since` predicate treats
    // as matching every dated row.
    const result = await getDenialBreakdown({
      since: new Date(since).toISOString(),
      project,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/denials]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
