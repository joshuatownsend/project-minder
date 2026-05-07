import { NextResponse } from "next/server";
import { listSubscriptions } from "@/lib/push/store";

export async function GET() {
  const subs = await listSubscriptions();
  // Exclude encryption key material (p256dh, auth) — not needed by the UI.
  const safe = subs.map(({ id, user_agent, created_at, last_seen_at, failure_count }) => ({
    id,
    user_agent,
    created_at,
    last_seen_at,
    failure_count,
  }));
  return NextResponse.json({ subscriptions: safe });
}
