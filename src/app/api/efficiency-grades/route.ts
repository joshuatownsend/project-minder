import { NextResponse } from "next/server";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";

export async function GET() {
  return NextResponse.json({
    grades: efficiencyGradeCache.getAll(),
    pending: efficiencyGradeCache.pending,
    total: efficiencyGradeCache.total,
  });
}
