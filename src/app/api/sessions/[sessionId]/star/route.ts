import { NextRequest, NextResponse } from "next/server";
import { demoWriteBlock } from "@/lib/demo/demoWriteGuard";
import { getDb } from "@/lib/db/connection";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const __demoBlocked = await demoWriteBlock();
  if (__demoBlocked) return __demoBlocked;
  const { sessionId } = await params;

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Atomic toggle: CASE WHEN inside a single UPDATE ... RETURNING avoids the
  // read-then-write race when two requests arrive concurrently (double-click,
  // two tabs). RETURNING yields no rows when WHERE matches nothing → 404.
  const newStarredAt = new Date().toISOString();
  const row = db
    .prepare(
      "UPDATE sessions SET starred_at = CASE WHEN starred_at IS NULL THEN ? ELSE NULL END " +
      "WHERE session_id = ? RETURNING starred_at"
    )
    .get(newStarredAt, sessionId) as { starred_at: string | null } | undefined;

  if (!row) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ starred: !!row.starred_at, starredAt: row.starred_at ?? undefined });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const row = db
    .prepare("SELECT starred_at FROM sessions WHERE session_id = ?")
    .get(sessionId) as { starred_at: string | null } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ starred: !!row.starred_at, starredAt: row.starred_at ?? null });
}
