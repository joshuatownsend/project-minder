import { NextRequest, NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/data";
import { getSessionMeta } from "@/lib/scanner/claudeStats";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { detail, meta } = await getSessionDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Enrich with Claude Code's own per-session metadata when present. Attached
  // here (not in the data loaders) so it applies to both the DB and file-parse
  // paths from one place. Best-effort: a missing/malformed record is null.
  detail.sessionMeta = (await getSessionMeta(detail.sessionId)) ?? undefined;

  return NextResponse.json(detail, {
    headers: { "X-Minder-Backend": meta.backend },
  });
}
