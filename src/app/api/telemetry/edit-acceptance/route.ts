import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getEditAcceptance } from "@/lib/db/otelQueries";

// GET /api/telemetry/edit-acceptance?since=ISO&sessionId=
// Returns per-tool accept/reject counts and rate for EditAcceptanceCard.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const sinceParam = searchParams.get("since");
  const sessionId  = searchParams.get("sessionId") ?? undefined;
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  const result = await getEditAcceptance({ since, sessionId });
  return NextResponse.json(result);
}
