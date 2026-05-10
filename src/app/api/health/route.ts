import { NextResponse } from "next/server";
import { getInitStatus } from "@/lib/data";

// Lightweight health endpoint — exposes the schema-readiness state
// machine snapshot. Used by the Settings DB-status row and any external
// monitor that wants to check whether the SQLite index is healthy
// without hitting a heavier read path. Intentionally does NOT trigger
// `ensureSchemaReady()` itself; it reports current state, never
// provokes a fresh init attempt.
export async function GET() {
  const initStatus = getInitStatus();
  const ok =
    initStatus.state === "success" || initStatus.state === "idle" || initStatus.state === "in-flight";
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
