import { NextResponse } from "next/server";
import { probeInitStatus } from "@/lib/data";

// Active health probe — drives `ensureSchemaReady()` forward (idempotent
// on a healthy DB or a within-TTL cached failure) so external monitors
// don't see a misleading `ok: true` on a never-probed `idle` state.
// `ok` is only true when the state machine has reached `success`; every
// other state (idle, in-flight, transient-failed, permanent-failed)
// returns 503 to signal "not yet healthy."
export async function GET() {
  const initStatus = await probeInitStatus();
  const ok = initStatus.state === "success";
  return NextResponse.json(
    {
      ok,
      db: initStatus,
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
