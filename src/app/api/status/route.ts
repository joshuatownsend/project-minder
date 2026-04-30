import { NextResponse } from "next/server";
import { getLiveStatusPayload } from "@/lib/liveStatus";

export async function GET() {
  const data = await getLiveStatusPayload();
  return NextResponse.json(data);
}
