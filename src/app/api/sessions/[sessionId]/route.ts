import { NextRequest, NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/data";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { detail, meta } = await getSessionDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(detail, {
    headers: { "X-Minder-Backend": meta.backend },
  });
}
