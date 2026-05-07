import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { Period } from "@/lib/db/otelQueries";
import { getCacheEfficiency } from "@/lib/db/otelQueries";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const period = (searchParams.get("period") ?? "7d") as Period;

  if (!["today", "7d", "30d"].includes(period)) {
    return NextResponse.json({ error: "period must be today|7d|30d" }, { status: 400 });
  }

  try {
    const result = await getCacheEfficiency({ period });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[telemetry/cache-efficiency]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
