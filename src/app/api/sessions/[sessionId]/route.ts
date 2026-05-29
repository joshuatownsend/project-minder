import { NextRequest, NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/data";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  // `getSessionDetail` enriches `detail.sessionMeta` in the façade, so both
  // this route and the `get-session` MCP tool get it.
  const { detail, meta } = await getSessionDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(detail, {
    headers: { "X-Minder-Backend": meta.backend },
  });
}
