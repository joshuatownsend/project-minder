import { NextRequest, NextResponse } from "next/server";
import { loadManualStepsResponse } from "@/lib/server/queries/manualSteps";

export async function GET(request: NextRequest) {
  const pendingOnly = request.nextUrl.searchParams.get("pending") === "true";
  return NextResponse.json(await loadManualStepsResponse(pendingOnly));
}
