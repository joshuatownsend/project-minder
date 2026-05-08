import { NextResponse } from "next/server";
import { listSchedules, createSchedule } from "@/lib/tasks/store";
import { validateCreateSchedule } from "@/lib/tasks/validation";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const schedules = await listSchedules();
    return NextResponse.json({ schedules });
  } catch (err) {
    console.error("[api/schedules GET]", err);
    return NextResponse.json({ error: "Failed to list schedules" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const validated = validateCreateSchedule(body);
    if ("error" in validated) {
      return NextResponse.json(
        { error: validated.error, field: validated.field },
        { status: 400 }
      );
    }
    const schedule = await createSchedule(validated);
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    console.error("[api/schedules POST]", err);
    return NextResponse.json({ error: "Failed to create schedule" }, { status: 500 });
  }
}
