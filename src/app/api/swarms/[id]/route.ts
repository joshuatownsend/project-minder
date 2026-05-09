import { NextResponse } from "next/server";
import { getSwarm, getSwarmTasks } from "@/lib/tasks/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "Invalid swarm id" }, { status: 400 });
  }
  try {
    const [swarm, tasks] = await Promise.all([getSwarm(numId), getSwarmTasks(numId)]);
    if (!swarm) {
      return NextResponse.json({ error: "Swarm not found" }, { status: 404 });
    }
    return NextResponse.json({ swarm, tasks });
  } catch (err) {
    console.error("[api/swarms/[id] GET]", err);
    return NextResponse.json({ error: "Failed to fetch swarm" }, { status: 500 });
  }
}
