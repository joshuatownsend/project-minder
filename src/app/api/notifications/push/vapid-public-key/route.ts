import { NextResponse } from "next/server";
import { getOrCreateVapidKeys } from "@/lib/push/vapid";

export async function GET() {
  const keys = await getOrCreateVapidKeys();
  return NextResponse.json({ publicKey: keys.publicKey });
}
