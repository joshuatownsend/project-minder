import { NextRequest, NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getFlag } from "@/lib/featureFlags";
import { getChanges, getCurrentStatus } from "@/lib/claudeStatus/cache";

/**
 * Combined claude-status endpoint (C2b): returns the current snapshot AND the
 * change events since the caller's cursor in ONE response, so the dashboard can
 * drive both the incident banner and the toast listener from a single 60s poll
 * instead of the two separate requests those two components used to make.
 *
 * The `/api/claude-status` and `/api/claude-status/changes` routes are left in
 * place for the MCP surface and any external callers; this route is the one the
 * consolidated `ClaudeStatusProvider` talks to.
 */
export async function GET(request: NextRequest) {
  const config = await readConfig();
  if (!getFlag(config.featureFlags, "claudeStatusAlerts")) {
    return NextResponse.json({ disabled: true, snapshot: null, changes: [] });
  }
  const snapshot = await getCurrentStatus();
  const since = request.nextUrl.searchParams.get("since");
  const changes = since ? getChanges(since) : [];
  return NextResponse.json({ disabled: false, snapshot, changes });
}
