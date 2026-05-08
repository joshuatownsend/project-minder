import { NextRequest, NextResponse } from "next/server";
import { listOpenDecisions } from "@/lib/tasks/store";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const taskIdRaw = request.nextUrl.searchParams.get("taskId");
  if (taskIdRaw !== null && parseId(taskIdRaw) === null) {
    return NextResponse.json({ error: "taskId must be a positive integer" }, { status: 400 });
  }
  const taskId = taskIdRaw !== null ? (parseId(taskIdRaw) ?? undefined) : undefined;

  try {
    const decisions = await listOpenDecisions(taskId);
    return NextResponse.json({ decisions });
  } catch (err) {
    console.error("[api/decisions GET]", err);
    return NextResponse.json({ error: "Failed to fetch decisions" }, { status: 500 });
  }
}
