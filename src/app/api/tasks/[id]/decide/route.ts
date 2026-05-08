import { NextResponse } from "next/server";
import { getTask, decideTask, listOpenDecisions } from "@/lib/tasks/store";
import { getStreamChild } from "@/lib/tasks/spawner";
import { parseId } from "@/lib/tasks/routeUtils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { decisionId, answer } = body as { decisionId?: unknown; answer?: unknown };

  if (typeof decisionId !== "number" || typeof answer !== "string") {
    return NextResponse.json({ error: "decisionId (number) and answer (string) are required" }, { status: 400 });
  }
  if (!answer.trim()) {
    return NextResponse.json({ error: "answer must not be empty" }, { status: 400 });
  }

  try {
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    // Verify the decision belongs to this task
    const openDecisions = await listOpenDecisions(id);
    const decision = openDecisions.find((d) => d.id === decisionId);
    if (!decision) {
      return NextResponse.json(
        { error: "Decision not found or already decided" },
        { status: 409 }
      );
    }

    // Check the stream child is still alive
    const child = getStreamChild(id);
    if (!child || child.exitCode !== null) {
      return NextResponse.json(
        { error: "Task process has already exited — decision cannot be delivered" },
        { status: 410 }
      );
    }

    // Write answer to child stdin
    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(answer + "\n", (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // Mark the decision as resolved
    const decided = await decideTask(decisionId, answer);
    return NextResponse.json({ decision: decided });
  } catch (err) {
    console.error("[api/tasks/[id]/decide POST]", err);
    return NextResponse.json({ error: "Failed to deliver decision" }, { status: 500 });
  }
}
