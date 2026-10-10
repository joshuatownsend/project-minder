import { NextRequest, NextResponse } from "next/server";
import { list, type HistoryEntry } from "@/lib/configHistory";
import { findProjectPathBySlug } from "@/lib/projectPath";

export async function GET(request: NextRequest) {
  const projectSlug = request.nextUrl.searchParams.get("project") || undefined;
  try {
    // History is scoped by the project's path, not its slug: root order decides which same-named project
    // owns an undecorated slug, so a slug can name a different project than the one that recorded an
    // entry (#635). An unknown slug has no project, hence no history.
    let projectPath: string | undefined;
    if (projectSlug) {
      projectPath = (await findProjectPathBySlug(projectSlug)) ?? undefined;
      if (!projectPath) return NextResponse.json({ entries: [] });
    }
    const entries = await list({ projectPath });
    // Strip server-local snapshotPath before returning. The browser
    // doesn't need a path inside ~/.minder/config-history/ — surfacing
    // it just couples the client to filesystem layout and adds an
    // unnecessary attack-surface line item.
    return NextResponse.json({ entries: entries.map(stripServerOnlyFields) });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

function stripServerOnlyFields(entry: HistoryEntry): Omit<HistoryEntry, "snapshotPath"> {
  const { snapshotPath: _omit, ...rest } = entry;
  void _omit;
  return rest;
}
