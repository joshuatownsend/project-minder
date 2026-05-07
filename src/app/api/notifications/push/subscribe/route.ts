import { NextRequest, NextResponse } from "next/server";
import { addSubscription } from "@/lib/push/store";

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  const ua = request.headers.get("user-agent");
  await addSubscription(
    { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } },
    ua
  );
  return NextResponse.json({ ok: true });
}
