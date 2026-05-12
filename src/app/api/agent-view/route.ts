import { NextResponse } from "next/server";
import { aggregateLiveSessions } from "@/lib/agentView/aggregate";
import { startJobRosterWatcher, refreshRoster } from "@/lib/agentView/jobRoster";
import { readConfig } from "@/lib/config";

// REST snapshot — same aggregate as the SSE route but for non-streaming
// clients and for the initial page load before EventSource connects.

export async function GET(): Promise<NextResponse> {
  const config = await readConfig();
  const abandonMin = config.agentView?.abandonThresholdMin;

  startJobRosterWatcher();
  await refreshRoster();

  const sessions = await aggregateLiveSessions(abandonMin);
  return NextResponse.json({ sessions, generatedAt: new Date().toISOString() });
}
