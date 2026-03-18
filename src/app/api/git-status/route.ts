import { NextResponse } from "next/server";
import { gitStatusCache } from "@/lib/gitStatusCache";

export async function GET() {
  return NextResponse.json({
    statuses: gitStatusCache.getAll(),
    pending: gitStatusCache.pending,
    total: gitStatusCache.total,
  });
}
