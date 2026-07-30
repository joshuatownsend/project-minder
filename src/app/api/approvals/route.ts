import { NextResponse } from "next/server";
import { listPendingApprovals } from "@/lib/approvals/store";

// `GET /api/approvals` — tool calls currently blocked waiting on a human.
//
// Polled by the dashboard and by the LAN phone view. Deliberately NOT
// cached and NOT prerendered: a stale list here means approving a request
// that already timed out, or missing one that is actively blocking a
// session.
export const dynamic = "force-dynamic";

export async function GET() {
  const pending = listPendingApprovals();
  return NextResponse.json({
    pending,
    // Surfaced so a client can render a countdown without a second clock
    // source; the server's deadline is the only one that decides.
    serverNowMs: Date.now(),
  });
}
