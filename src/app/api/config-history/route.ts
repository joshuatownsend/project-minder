import { NextRequest, NextResponse } from "next/server";
import { list, type HistoryEntry } from "@/lib/configHistory";

export async function GET(request: NextRequest) {
  const projectSlug = request.nextUrl.searchParams.get("project") || undefined;
  try {
    const entries = await list({ projectSlug });
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
