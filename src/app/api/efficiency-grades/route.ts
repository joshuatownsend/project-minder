import { NextResponse } from "next/server";
import { efficiencyGradeCache } from "@/lib/efficiencyGradeCache";
import { loadGradeTrends } from "@/lib/data/gradeSnapshots";

export async function GET() {
  const grades = efficiencyGradeCache.getAll();
  // Best-effort: trends is {} when the DB is unavailable (item 4b). The card
  // shows a grade with no trend arrow in that case, never an error.
  const trends = await loadGradeTrends(grades);
  return NextResponse.json({
    grades,
    trends,
    pending: efficiencyGradeCache.pending,
    total: efficiencyGradeCache.total,
  });
}
