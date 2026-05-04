import { NextRequest, NextResponse } from "next/server";
import {
  loadSessionTurnsBySessionId,
  SessionTurnsLoadError,
} from "@/lib/usage/parser";
import { diagnoseSession } from "@/lib/usage/sessionDiagnosis";

// `GET /api/sessions/[sessionId]/quality` — produces the full
// `DiagnosisReport` (per TODO #106) for one session.
//
// Always uses the file-parse path (`loadSessionTurnsBySessionId`) regardless
// of `MINDER_USE_DB`. Reasoning: `loadSessionDetailFromDb` documents several
// divergences from the canonical JSONL — notably no thinking blocks,
// collapsed `text_preview`, and dropped sidechain entries — which weaken
// the diagnosis signal. Until DB-native compute closes those gaps, this
// route stays JSONL-canonical so findings are trustworthy.
//
// SessionId shape is validated inside `loadSessionTurnsBySessionId`
// (hex/hyphen allowlist sufficient to block path-traversal characters).
//
// Three response shapes:
//   • 200 + DiagnosisReport — session resolved and parsed (may be empty findings)
//   • 404 — session not found OR oversized (treated as unresolvable)
//   • 500 — session resolved but read/parse failed; clients must NOT
//     interpret this as "looks healthy" — the loader throws
//     `SessionTurnsLoadError` precisely so a broken file can't masquerade
//     as a clean diagnosis.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  let turns;
  try {
    turns = await loadSessionTurnsBySessionId(sessionId);
  } catch (err) {
    if (err instanceof SessionTurnsLoadError) {
      // Log the underlying cause for the operator; clients see only the
      // short message because `cause` may include filesystem paths.
      // eslint-disable-next-line no-console
      console.error(`[/api/sessions/${sessionId}/quality]`, err);
      return NextResponse.json(
        { error: `Could not parse session JSONL: ${err.message}` },
        { status: 500 }
      );
    }
    throw err;
  }
  if (turns === null) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const report = diagnoseSession(sessionId, turns);
  return NextResponse.json(report);
}
