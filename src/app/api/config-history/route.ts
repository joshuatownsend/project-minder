import { NextRequest, NextResponse } from "next/server";
import { list, type HistoryEntry } from "@/lib/configHistory";
import { getScannedProjects } from "@/lib/projectPath";

export async function GET(request: NextRequest) {
  const projectSlug = request.nextUrl.searchParams.get("project") || undefined;
  try {
    // History is scoped by the project's path, not its slug: root order decides which same-named project
    // owns an undecorated slug, so a slug can name a different project than the one that recorded an
    // entry (#635). An unknown slug has no project, hence no history.
    let filter: { projectPath?: string; otherProjects?: string[] } = {};
    if (projectSlug) {
      const projects = await getScannedProjects();
      const project = projects.find((p) => p.slug === projectSlug);
      if (!project) return NextResponse.json({ entries: [] });
      // Other project paths keep a nested project's older snapshots off its parent's tab.
      filter = { projectPath: project.path, otherProjects: projects.filter((p) => p !== project).map((p) => p.path) };
    }
    const entries = await list(filter);
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
