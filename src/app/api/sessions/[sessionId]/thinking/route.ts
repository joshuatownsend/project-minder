import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/connection";
import { readThinkingFromJsonl } from "@/lib/data/thinkingContent";

// `GET /api/sessions/[sessionId]/thinking?turnId=<N>` — on-demand thinking
// content for a single assistant turn. Reads the turn's byte offset from the
// DB and extracts thinking blocks from the JSONL file at that position.
//
// Lazy-fetched: only called when the user expands a thinking event in the
// SessionTimeline. The DB path never persists thinking content inline;
// this route provides it on demand via `turns.text_offset`.
//
// Three response shapes:
//   • 200 + { content: string } — thinking content found
//   • 400 — missing or invalid turnId parameter
//   • 404 — no thinking content at this offset (offset missing, file gone,
//            or no thinking blocks in that JSONL line)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const turnIdRaw = searchParams.get("turnId");
  if (!turnIdRaw) {
    return NextResponse.json({ error: "turnId query parameter required" }, { status: 400 });
  }
  const turnIndex = parseInt(turnIdRaw, 10);
  if (!Number.isFinite(turnIndex) || turnIndex < 0) {
    return NextResponse.json({ error: "turnId must be a non-negative integer" }, { status: 400 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const content = await readThinkingFromJsonl(db, sessionId, turnIndex);
  if (content === null) {
    return NextResponse.json(
      { error: "Thinking content unavailable for this turn" },
      { status: 404 }
    );
  }

  return NextResponse.json({ content });
}
