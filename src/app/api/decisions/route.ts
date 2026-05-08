import { NextRequest, NextResponse } from "next/server";
import { listOpenDecisions } from "@/lib/tasks/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const taskIdRaw = request.nextUrl.searchParams.get("taskId");
  const taskId = taskIdRaw ? parseInt(taskIdRaw, 10) : undefined;

  try {
    const decisions = await listOpenDecisions(Number.isFinite(taskId) ? taskId : undefined);
    return NextResponse.json({ decisions });
  } catch (err) {
    console.error("[api/decisions GET]", err);
    return NextResponse.json({ error: "Failed to fetch decisions" }, { status: 500 });
  }
}
