import { NextRequest, NextResponse } from "next/server";
import { listInbox } from "@/lib/tasks/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(parseInt(limitRaw, 10), 200)) : 50;

  try {
    const messages = await listInbox(Number.isFinite(limit) ? limit : 50);
    return NextResponse.json({ messages });
  } catch (err) {
    console.error("[api/inbox GET]", err);
    return NextResponse.json({ error: "Failed to fetch inbox" }, { status: 500 });
  }
}
