import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getCurrentStatus } from "@/lib/claudeStatus/cache";

export async function GET() {
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
    return NextResponse.json({ disabled: true });
  }
  const snapshot = await getCurrentStatus();
  return NextResponse.json(snapshot);
}
