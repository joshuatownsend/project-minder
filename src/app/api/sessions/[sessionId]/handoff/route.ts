import { NextRequest, NextResponse } from "next/server";
import {
  loadSessionTurnsWithPath,
  getJsonlMaxMtime,
  SessionTurnsLoadError,
} from "@/lib/usage/parser";
import {
  extractHandoffFacts,
  readCompactionSummary,
  scoreCompactionFidelity,
} from "@/lib/usage/sessionHandoff";
import type { HandoffFacts, CompactionFidelity } from "@/lib/usage/sessionHandoff";
import { generateHandoffDoc } from "@/lib/usage/sessionHandoffDoc";
import type { HandoffVerbosity } from "@/lib/usage/sessionHandoffDoc";
import { getOrCreateRouteCache } from "@/lib/routeCache";
import { indexedSessionPath } from "@/lib/data/indexedSessionPath";

const VALID_VERBOSITIES = new Set<HandoffVerbosity>([
  "minimal",
  "standard",
  "verbose",
  "full",
]);

const CACHE_TTL_MS = 5 * 60 * 1000;

interface HandoffResponse {
  sessionId: string;
  facts: HandoffFacts;
  fidelity: CompactionFidelity | null;
  doc: string;
  meta: { durationMs: number };
}

interface CacheSlot {
  data: HandoffResponse;
  jsonlMtime: number;
}

const cache = getOrCreateRouteCache<CacheSlot>("handoff", { ttlMs: CACHE_TTL_MS });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const start = Date.now();
  const { sessionId } = await params;

  const verbosityParam = request.nextUrl.searchParams.get("verbosity") ?? "standard";
  if (!VALID_VERBOSITIES.has(verbosityParam as HandoffVerbosity)) {
    return NextResponse.json(
      {
        error: `Invalid verbosity. Must be one of: ${[...VALID_VERBOSITIES].join(", ")}`,
      },
      { status: 400 }
    );
  }
  const verbosity = verbosityParam as HandoffVerbosity;

  const cacheKey = `${sessionId}:${verbosity}`;
  const cached = cache.get(cacheKey);
  const currentMtime = getJsonlMaxMtime();
  if (cached && cached.jsonlMtime === currentMtime) {
    return NextResponse.json(cached.data);
  }

  let loaded;
  try {
    // WITH the index hint, and keeping the path it resolved. One walk for the
    // whole request instead of one per consumer of it (#486).
    loaded = await loadSessionTurnsWithPath(sessionId, {
      indexedPath: indexedSessionPath,
    });
  } catch (err) {
    if (err instanceof SessionTurnsLoadError) {
      // eslint-disable-next-line no-console
      console.error(`[/api/sessions/${sessionId}/handoff]`, err);
      return NextResponse.json(
        { error: `Could not parse session JSONL: ${err.message}` },
        { status: 500 }
      );
    }
    throw err;
  }
  if (!loaded) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const { turns, filePath: locatedPath } = loaded;

  const facts = extractHandoffFacts(turns);

  // RESOLVED, not reconstructed (#486). This built
  // `~/.claude/projects/<dir>/<id>.jsonl` by hand, which is wrong twice over:
  // it assumes the FLAT layout, so a nested subagent transcript was never
  // found; and it hardcodes `os.homedir()`, so a session in any configured
  // extra Claude home was never found either. Both failures are silent — the
  // read misses and fidelity is simply reported as absent, which is
  // indistinguishable from a session that was never compacted.
  //
  // REUSED from the loader above, not resolved a second time.
  // `loadSessionTurnsBySessionId` has already located this transcript, so a
  // fresh `resolveSessionJsonl` here could not remove the first walk — it would
  // add a second one whenever the index is off, unavailable, or missing the row
  // (Codex P2, PR #526).
  let fidelity: CompactionFidelity | null = null;
  if (locatedPath) {
    const summary = await readCompactionSummary(locatedPath);
    if (summary) {
      fidelity = scoreCompactionFidelity(facts, summary);
    }
  }

  const doc = generateHandoffDoc({
    sessionId,
    projectName: turns[0]?.projectSlug ?? undefined,
    facts,
    fidelity: fidelity ?? undefined,
    turns,
    verbosity,
  });

  const now = Date.now();
  const data: HandoffResponse = {
    sessionId,
    facts,
    fidelity,
    doc,
    meta: { durationMs: now - start },
  };
  cache.set(cacheKey, { data, jsonlMtime: currentMtime });
  return NextResponse.json(data);
}
