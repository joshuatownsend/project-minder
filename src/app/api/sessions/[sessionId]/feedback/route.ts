import { NextRequest, NextResponse } from "next/server";
import { getSessionFacets } from "@/lib/scanner/claudeFacets";

// `GET /api/sessions/[sessionId]/feedback` — per-session Claude qualitative
// feedback (facets). Reads `~/.claude/usage-data/facets/<sessionId>.json`.
//
// Three response shapes:
//   • 200 + FacetData — file found and parsed
//   • 404 — file absent ("no feedback recorded for this session")
//   • 500 — file found but failed to parse (malformed JSON is a loud error)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  let facets;
  try {
    facets = await getSessionFacets(sessionId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[/api/sessions/${sessionId}/feedback]`, err);
    return NextResponse.json(
      { error: `Could not parse facets file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  if (facets === null) {
    return NextResponse.json({ error: "No feedback recorded for this session" }, { status: 404 });
  }

  return NextResponse.json(facets);
}
