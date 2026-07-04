import { NextResponse } from "next/server";
import { listSwarms, createSwarm } from "@/lib/tasks/store";
import type { SwarmMode } from "@/lib/tasks/types";
import { SWARM_MODES, EXECUTION_MODES } from "@/lib/tasks/types";
import { initDispatcher } from "@/lib/tasks/dispatcher";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // No initDispatcher() here: GET is read-only (see the tasks route GET for the
  // CSRF rationale). The dispatcher starts at server boot and on POST.
  try {
    const swarms = await listSwarms();
    return NextResponse.json({ swarms });
  } catch (err) {
    console.error("[api/swarms GET]", err);
    return NextResponse.json({ error: "Failed to list swarms" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  initDispatcher();
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { name, mode, project_path, members, coordinator } = body as Record<string, unknown>;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", field: "name" }, { status: 400 });
    }
    if (!mode || !SWARM_MODES.includes(mode as SwarmMode)) {
      return NextResponse.json(
        { error: `mode must be one of: ${SWARM_MODES.join(", ")}`, field: "mode" },
        { status: 400 }
      );
    }
    if (!project_path || typeof project_path !== "string" || !project_path.trim()) {
      return NextResponse.json(
        { error: "project_path is required", field: "project_path" },
        { status: 400 }
      );
    }
    if (!Array.isArray(members) || members.length < 2 || members.length > 8) {
      return NextResponse.json(
        { error: "members must be an array of 2–8 items", field: "members" },
        { status: 400 }
      );
    }
    for (const m of members) {
      if (!m || typeof m.title !== "string" || !m.title.trim()) {
        return NextResponse.json(
          { error: "each member must have a non-empty title", field: "members" },
          { status: 400 }
        );
      }
      if (m.execution_mode !== undefined && !(EXECUTION_MODES as readonly string[]).includes(m.execution_mode as string)) {
        return NextResponse.json(
          { error: `execution_mode must be one of: ${EXECUTION_MODES.join(", ")}`, field: "members" },
          { status: 400 }
        );
      }
    }

    if (coordinator !== undefined) {
      if (!coordinator || typeof (coordinator as Record<string, unknown>).title !== "string" ||
          !(coordinator as Record<string, unknown>).title) {
        return NextResponse.json(
          { error: "coordinator must have a non-empty title", field: "coordinator" },
          { status: 400 }
        );
      }
    }

    const result = await createSwarm({
      name: (name as string).trim(),
      mode: mode as SwarmMode,
      project_path: (project_path as string).trim(),
      members,
      coordinator: coordinator as { title: string; description?: string; assigned_skill?: string } | undefined,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("[api/swarms POST]", err);
    return NextResponse.json({ error: "Failed to create swarm" }, { status: 500 });
  }
}
