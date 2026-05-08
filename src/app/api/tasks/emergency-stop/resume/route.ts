import { NextResponse } from "next/server";
import { resumeDispatcher } from "@/lib/tasks/emergencyStop";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    await resumeDispatcher();
    return NextResponse.json({ resumed: true });
  } catch (err) {
    console.error("[api/tasks/emergency-stop/resume POST]", err);
    return NextResponse.json({ error: "Resume failed" }, { status: 500 });
  }
}
