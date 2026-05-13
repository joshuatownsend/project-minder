import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getChanges, getCurrentStatus } from "@/lib/claudeStatus/cache";

export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get("since");
  if (!since) {
    return NextResponse.json({ error: "since parameter required" }, { status: 400 });
  }
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
    return NextResponse.json([]);
  }
  // Ensure the singleton has at least once snapshot so a poll arriving
  // before the first fetch doesn't return an empty diff window forever.
  await getCurrentStatus();
  return NextResponse.json(getChanges(since));
}
