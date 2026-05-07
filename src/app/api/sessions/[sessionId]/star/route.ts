import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { getSessionDetail } from "@/lib/data";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { detail } = await getSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const nowStarred = !detail.starredAt;
  const starredAt = nowStarred ? new Date().toISOString() : null;
  db.prepare("UPDATE sessions SET starred_at = ? WHERE session_id = ?").run(starredAt, sessionId);

  return NextResponse.json({ starred: nowStarred, starredAt: starredAt ?? undefined });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { detail } = await getSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({ starred: !!detail.starredAt, starredAt: detail.starredAt ?? null });
}
