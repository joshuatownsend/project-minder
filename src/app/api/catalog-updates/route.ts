import { NextResponse } from "next/server";
import { skillUpdateCache } from "@/lib/skillUpdateCache";

export async function GET() {
  return NextResponse.json({
    statuses: skillUpdateCache.getAll(),
    pending: skillUpdateCache.pending,
    total: skillUpdateCache.total,
  });
}
