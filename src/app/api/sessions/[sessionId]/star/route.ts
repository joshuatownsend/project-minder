import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";

export async function POST(
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

  const nowStarred = !row.starred_at;
  const starredAt = nowStarred ? new Date().toISOString() : null;
  db.prepare("UPDATE sessions SET starred_at = ? WHERE session_id = ?").run(starredAt, sessionId);

  return NextResponse.json({ starred: nowStarred, starredAt: starredAt ?? undefined });
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
