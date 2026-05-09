import { NextResponse } from "next/server";
import { removeDependency } from "@/lib/tasks/store";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; blockerId: string }> }
): Promise<NextResponse> {
  const { id, blockerId: blockerIdStr } = await params;
  const taskId = parseId(id);
  const blockerId = parseId(blockerIdStr);

  if (taskId === null || blockerId === null) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  await removeDependency(taskId, blockerId);
  return new NextResponse(null, { status: 204 });
}
