import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { resolveSessionJsonl } from "@/lib/usage/sessionPath";
import {
  attributeContext,
  type AttributionEntry,
} from "@/lib/usage/contextAttribution";

// `GET /api/sessions/[sessionId]/context-attribution` — per-turn breakdown
// of what filled the context window over one session.
//
// **Reads raw JSONL, not the parsed turn model, and not the DB.** Both of
// the existing paths destroy exactly the information this endpoint needs:
// `UsageTurn` caps text at 500 chars (a parity contract with the DB path —
// see `USAGE_USER_TEXT_LIMIT` in ingest.ts), and `loadSessionDetailFromDb`
// documents that it drops thinking blocks and collapses previews. Either
// would produce a chart whose bars are all the same truncated size. The
// same reasoning is why `/quality` is JSONL-canonical.
//
// Cost is one file read per request for one session — the scale at which
// on-demand compute is appropriate, and the reason this needed no schema
// change or DERIVED_VERSION bump.
//
// Responses:
//   • 200 + ContextAttributionReport
//   • 404 — session not found, or larger than the parse ceiling
//   • 500 — resolved but unreadable; deliberately NOT an empty report,
//     which would render as "this session used no context".

// Matches `MAX_SESSION_FILE_SIZE` in the parser. A 50 MB JSONL is a
// runaway log, and attributing it would allocate its full text.
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  // Same allowlist the parser applies before touching the filesystem —
  // blocks path-traversal characters at the boundary.
  if (!/^[a-f0-9-]+$/i.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 404 });
  }

  const windowParam = request.nextUrl.searchParams.get("contextWindow");
  let contextWindow: number | undefined;
  if (windowParam !== null) {
    const parsed = Number.parseInt(windowParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "contextWindow must be a positive integer" },
        { status: 400 }
      );
    }
    contextWindow = parsed;
  }

  let resolved;
  try {
    resolved = await resolveSessionJsonl(sessionId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[/api/sessions/${sessionId}/context-attribution] resolve`, err);
    return NextResponse.json(
      { error: "Failed to list Claude projects directories" },
      { status: 500 }
    );
  }
  if (!resolved) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  let raw: string;
  try {
    const stat = await fs.stat(resolved.filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      return NextResponse.json({ error: "Session file too large" }, { status: 404 });
    }
    raw = await fs.readFile(resolved.filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Removed between resolve and read.
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // eslint-disable-next-line no-console
    console.error(`[/api/sessions/${sessionId}/context-attribution] read`, err);
    return NextResponse.json({ error: "Failed to read session JSONL" }, { status: 500 });
  }

  const entries: AttributionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AttributionEntry);
    } catch {
      // A single truncated line (common on a session still being written)
      // must not fail the whole report. Skipping it loses one turn's
      // worth of attribution, which is visibly incomplete rather than
      // wrong — unlike returning 500 for a live session.
    }
  }

  return NextResponse.json(attributeContext(sessionId, entries, contextWindow));
}
