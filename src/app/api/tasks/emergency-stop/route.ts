import { NextResponse } from "next/server";
import { emergencyStop } from "@/lib/tasks/emergencyStop";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const result = await emergencyStop();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/tasks/emergency-stop POST]", err);
    return NextResponse.json({ error: "Emergency stop failed" }, { status: 500 });
  }
}
