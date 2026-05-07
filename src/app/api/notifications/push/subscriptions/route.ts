import { NextResponse } from "next/server";
import { listSubscriptions } from "@/lib/push/store";

export async function GET() {
  const subs = await listSubscriptions();
  return NextResponse.json({ subscriptions: subs });
}
