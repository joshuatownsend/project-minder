import { NextResponse } from "next/server";
import { getSchedule, patchSchedule, deleteSchedule } from "@/lib/tasks/store";
import { validatePatchSchedule } from "@/lib/tasks/validation";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 });
  }
  try {
    const schedule = await getSchedule(id);
    if (!schedule) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    return NextResponse.json({ schedule });
  } catch (err) {
    console.error("[api/schedules/[id] GET]", err);
    return NextResponse.json({ error: "Failed to fetch schedule" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 });
  }
  try {
    const body = await request.json().catch(() => null);
    const validated = validatePatchSchedule(body);
    if ("error" in validated) {
      return NextResponse.json(
        { error: validated.error, field: (validated as { field?: string }).field },
        { status: 400 }
      );
    }
    const updated = await patchSchedule(id, validated);
    if (!updated) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    return NextResponse.json({ schedule: updated });
  } catch (err) {
    console.error("[api/schedules/[id] PATCH]", err);
    return NextResponse.json({ error: "Failed to update schedule" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid schedule id" }, { status: 400 });
  }
  try {
    const deleted = await deleteSchedule(id);
    if (!deleted) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/schedules/[id] DELETE]", err);
    return NextResponse.json({ error: "Failed to delete schedule" }, { status: 500 });
  }
}
