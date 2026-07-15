import { NextResponse } from "next/server";
import { gitStatusCache } from "@/lib/gitStatusCache";
import { demoMode } from "@/lib/demo/demoMode";
import { demoGitStatus } from "@/lib/demo/activity";

export async function GET() {
  if (await demoMode()) {
    const statuses = demoGitStatus(Date.now());
    return NextResponse.json({ statuses, pending: 0, total: Object.keys(statuses).length });
  }
  return NextResponse.json({
    statuses: gitStatusCache.getAll(),
    pending: gitStatusCache.pending,
    total: gitStatusCache.total,
  });
}
