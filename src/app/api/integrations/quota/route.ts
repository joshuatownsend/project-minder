import { NextResponse } from "next/server";
import { loadQuota } from "@/lib/quota";
import { demoMode } from "@/lib/demo/demoMode";
import { demoQuota } from "@/lib/demo/activity";

export async function GET() {
  if (await demoMode()) {
    return NextResponse.json(demoQuota(Date.now()));
  }
  const result = await loadQuota();
  return NextResponse.json(result);
}
