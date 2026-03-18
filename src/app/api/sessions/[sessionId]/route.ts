import { NextRequest, NextResponse } from "next/server";
import { scanSessionDetail } from "@/lib/scanner/claudeConversations";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const detail = await scanSessionDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
