import { NextRequest, NextResponse } from "next/server";
import { loadInsightsResponse } from "@/lib/server/queries/insights";

// Response assembly lives in `@/lib/server/queries/insights` so the RSC prefetch
// (PR 3) produces a byte-identical body.

export async function GET(request: NextRequest) {
  const projectFilter = request.nextUrl.searchParams.get("project");
  const query = request.nextUrl.searchParams.get("q");

  const body = await loadInsightsResponse(projectFilter, query);
  return NextResponse.json(body);
}
