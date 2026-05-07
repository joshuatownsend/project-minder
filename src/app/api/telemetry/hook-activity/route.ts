import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { getHookActivity } from "@/lib/db/otelQueries";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get("since");
  const since      = sinceParam ? new Date(sinceParam).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;

  if (!Number.isFinite(since)) {
    return NextResponse.json({ error: "Invalid since parameter" }, { status: 400 });
  }

  try {
    const result = await getHookActivity({ since });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/hook-activity]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
