import { NextResponse } from "next/server";
import { removeDependency } from "@/lib/tasks/store";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; blockerId: string }> }
): Promise<NextResponse> {
  const { id, blockerId: blockerIdStr } = await params;
  const taskId = parseInt(id, 10);
  const blockerId = parseInt(blockerIdStr, 10);

  if (!Number.isFinite(taskId) || !Number.isFinite(blockerId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  await removeDependency(taskId, blockerId);
  return new NextResponse(null, { status: 204 });
}
