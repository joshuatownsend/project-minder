import { NextRequest, NextResponse } from "next/server";
import { removeSubscription } from "@/lib/push/store";

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (typeof body?.endpoint !== "string") {
    return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  }
  await removeSubscription(body.endpoint);
  return NextResponse.json({ ok: true });
}
