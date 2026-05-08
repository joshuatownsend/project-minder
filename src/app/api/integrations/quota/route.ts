import { NextResponse } from "next/server";
import { loadQuota } from "@/lib/quota";

export async function GET() {
  const result = await loadQuota();
  return NextResponse.json(result);
}
